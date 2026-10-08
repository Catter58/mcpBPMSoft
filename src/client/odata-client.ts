/**
 * OData Client for BPMSoft
 *
 * High-level OData operations built on top of HttpClient.
 * Handles URL construction, query parameters, pagination,
 * binary field I/O, and response normalization.
 */

import type {
  HttpResponse,
  HttpRequestOptions,
  BpmConfig,
  ODataCollectionResponse,
  ODataVersion,
} from '../types/index.js';
import { HttpClient } from './http-client.js';
import { getAuthCacheScope } from '../auth/request-context.js';
import { getODataBaseUrl } from '../config.js';
import { BpmApiError, isQueryUnsupportedError } from '../utils/errors.js';
import { getBatchSupport, setBatchSupport } from '../utils/server-capabilities.js';
import { assertSafeIdentifier, assertGuid } from '../utils/odata.js';

export interface QueryOptions {
  $filter?: string;
  $select?: string;
  $top?: number;
  $skip?: number;
  $orderby?: string;
  $expand?: string;
  $count?: boolean;
}

/** Результат загрузки $metadata: тело, ETag и признак «не изменилось». */
export interface MetadataFetchResult {
  xml: string;
  etag?: string;
  notModified: boolean;
}

/** Normalized collection response (handles both v3 __next and v4 @odata.nextLink) */
export interface NormalizedCollection<T> {
  value: T[];
  nextLink?: string;
  count?: number;
}

interface PageBoundary {
  start: number;
  end: number;
  url: string;
  continuation?: string;
}

// Keep pagination bookkeeping out of the public OData response shape.
const pageBoundariesByResponse = new WeakMap<object, PageBoundary[]>();

export interface WriteOptions {
  expectedEtag?: string;
  returnRepresentation?: boolean;
}
export interface CreateOptions {
  id?: string;
}
export interface CreateOutcome<T> {
  record: T;
  created: boolean | null;
}
export interface BinaryFieldOptions {
  fieldType?: 'Edm.Binary' | 'Edm.Stream';
}
export interface ClientBatchResponse {
  id: string;
  status: number;
  body: unknown;
  state: 'completed' | 'failed' | 'not_executed' | 'outcome_unknown';
}
export interface ClientBatchRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  /** Metadata-known Decimal/Int64 fields requiring lossless numeric JSON in native batch bodies. */
  numericFields?: readonly string[];
}

export class ODataClient {
  private baseUrl: string;
  private origin: string;
  private odataVersion: ODataVersion;
  private nativeCollationScopes = new Map<string, number>();

  constructor(
    private config: BpmConfig,
    private httpClient: HttpClient
  ) {
    this.baseUrl = getODataBaseUrl(config);
    this.origin = new URL(this.baseUrl).origin;
    this.odataVersion = config.odata_version;

    // Lock HttpClient to BPMSoft origin to prevent SSRF via @odata.nextLink
    this.httpClient.setAllowedOrigin(this.origin);
  }

  /**
   * Get records from a collection with optional query parameters.
   * Supports auto-pagination when results exceed page size.
   */
  async getRecords<T = Record<string, unknown>>(
    collection: string,
    query?: QueryOptions,
    autoPaginate: boolean = false,
    maxRecords?: number
  ): Promise<ODataCollectionResponse<T>> {
    const limit = validateLimit(maxRecords);
    const stableQuery = { ...query, $orderby: stableOrder(query?.$orderby) };
    if (Number.isFinite(limit)) stableQuery.$top = Math.min(query?.$top ?? this.config.page_size, limit + 1);
    else if (stableQuery.$top === undefined) stableQuery.$top = this.config.page_size;
    const initialUrl = this.buildCollectionUrl(collection, stableQuery);
    const result = await this.readPage<T>(initialUrl);
    let delivered = 0;
    let page = result;
    let pageUrl = initialUrl;
    const values: T[] = [];
    const boundaries: PageBoundary[] = [];
    const visited = new Set<string>([initialUrl]);
    while (true) {
      const remaining = limit - delivered;
      const accepted = page.value.slice(0, remaining);
      const start = delivered;
      values.push(...accepted);
      delivered += accepted.length;
      let continuation = page['@odata.nextLink'];
      if (accepted.length < page.value.length) {
        // A backend may ignore $top. Advance within this exact server page so
        // token-based links and in-page offsets remain valid.
        continuation = continuationAfter(pageUrl, accepted.length);
      }
      boundaries.push({ start, end: delivered, url: pageUrl, continuation });
      result['@odata.nextLink'] = continuation;
      if (!autoPaginate || !continuation || delivered >= limit) break;
      const nextUrl = this.validateNextLink(collection, continuation);
      if (visited.has(nextUrl))
        throw new BpmApiError('Сервер вернул повторяющуюся ссылку пагинации.', 502, collection);
      visited.add(nextUrl);
      pageUrl = nextUrl;
      page = await this.readPage<T>(nextUrl);
      if (page.warnings?.length)
        result.warnings = [...new Set([...(result.warnings ?? []), ...page.warnings])];
      if (page.matching) result.matching = page.matching;
    }
    result.value = values;
    if (!result['@odata.nextLink']) delete result['@odata.nextLink'];
    pageBoundariesByResponse.set(result, boundaries);
    return result;
  }

  /** Resume the server-owned continuation, restricted to the same collection. */
  async getNextPage<T = Record<string, unknown>>(
    collection: string,
    nextLink: string,
    maxRecords?: number
  ): Promise<ODataCollectionResponse<T>> {
    const limit = validateLimit(maxRecords);
    const url = this.validateNextLink(collection, nextLink);
    const result = await this.readPage<T>(url);
    if (result.value.length > limit) {
      const parsed = new URL(url);
      const skip = Number(parsed.searchParams.get('$skip') ?? 0);
      if (parsed.searchParams.has('$skiptoken')) {
        // Re-fetch this token page and retain its in-page position in a private
        // fragment. The fragment is never sent to the backend.
        result['@odata.nextLink'] = withPageOffset(url, limit);
      } else result['@odata.nextLink'] = offsetContinuation(url, skip + limit);
      result.value = result.value.slice(0, limit);
    }
    pageBoundariesByResponse.set(result, [
      { start: 0, end: result.value.length, url, continuation: result['@odata.nextLink'] },
    ]);
    return result;
  }

  private async readPage<T>(url: string): Promise<ODataCollectionResponse<T>> {
    const parsed = new URL(url);
    const fragmentOffset = parsed.hash.startsWith('#mcp-offset=') ? Number(parsed.hash.slice(12)) : 0;
    parsed.hash = '';
    let read: { response: HttpResponse<unknown>; fallback: boolean };
    let countDetails: Awaited<ReturnType<ODataClient['getCountWithDetails']>> | undefined;
    let countWarning: string | undefined;
    try {
      read = await this.readCompatible<unknown>(parsed.toString(), 'crud');
    } catch (error) {
      if (parsed.searchParams.get('$count') !== 'true' || !isQueryUnsupportedError(error)) throw error;
      // Retry a read without the unsupported inline count; never replay a write.
      parsed.searchParams.delete('$count');
      read = await this.readCompatible<unknown>(parsed.toString(), 'crud');
      const collection = decodeURIComponent(parsed.pathname.split('/').at(-1)!);
      try {
        countDetails = await this.getCountWithDetails(
          collection,
          parsed.searchParams.get('$filter') ?? undefined
        );
        countWarning = 'Встроенный $count=true не поддержан; итог получен отдельным запросом /$count.';
      } catch {
        countWarning = 'Встроенный $count=true и отдельный /$count недоступны; общий итог не указан.';
      }
    }
    const result = normalizeCollection<T>(read.response.data);
    if (read.fallback) {
      result.warnings = [COLLATION_WARNING];
      result.matching = 'platform_collation';
    }
    if (countDetails) {
      result['@odata.count'] = countDetails.count;
      result.warnings = [...new Set([...(result.warnings ?? []), ...countDetails.warnings])];
      if (countDetails.matching) result.matching = countDetails.matching;
    }
    if (countWarning) result.warnings = [...(result.warnings ?? []), countWarning];
    if (fragmentOffset) result.value = result.value.slice(fragmentOffset);
    return result;
  }

  /** Get a single record by ID */
  async getRecord<T = Record<string, unknown>>(
    collection: string,
    id: string,
    query?: Pick<QueryOptions, '$select' | '$expand'>
  ): Promise<T> {
    const url = this.buildRecordUrl(collection, id, query);
    const response = await this.httpClient.request<T>({
      method: 'GET',
      url,
      contentKind: 'crud',
    });
    const record = unwrapSingle<T>(response.data);
    if (record && typeof record === 'object' && response.headers.etag) {
      return { ...record, '@odata.etag': response.headers.etag };
    }
    return record;
  }

  /** Get record count */
  async getCount(collection: string, filter?: string, warnings?: string[]): Promise<number> {
    const result = await this.getCountWithDetails(collection, filter);
    warnings?.push(...result.warnings);
    return result.count;
  }

  async getCountWithDetails(
    collection: string,
    filter?: string
  ): Promise<{ count: number; warnings: string[]; matching?: 'platform_collation' }> {
    const params = new URLSearchParams();
    if (filter) params.set('$filter', filter);
    const url = `${this.buildCollectionPath(collection)}/$count${params.toString() ? '?' + params.toString() : ''}`;
    const { response, fallback } = await this.readCompatible<string>(url, 'count', 'text');
    const count = normalizeCount(response.data, response.status, collection);
    return {
      count,
      warnings: fallback ? [COLLATION_WARNING] : [],
      ...(fallback ? { matching: 'platform_collation' as const } : {}),
    };
  }

  private async readCompatible<T>(
    url: string,
    contentKind: 'crud' | 'count',
    responseType?: 'text'
  ): Promise<{ response: HttpResponse<T>; fallback: boolean }> {
    const parsed = new URL(url);
    const filter = parsed.searchParams.get('$filter');
    const plain = filter ? removeLowercaseFunctions(filter) : undefined;
    const eligible = !!filter && plain !== undefined && plain !== filter;
    const scope = `${parsed.origin}${parsed.pathname.replace(/\/\$count$/, '')}:${getAuthCacheScope() || this.config.username || ''}`;
    const now = Date.now();
    for (const [key, expires] of this.nativeCollationScopes)
      if (expires <= now) this.nativeCollationScopes.delete(key);
    const request = (target: string) =>
      this.httpClient.request<T>({ method: 'GET', url: target, contentKind, responseType });
    const verified = (response: HttpResponse<T>) => {
      if (contentKind === 'crud') normalizeCollection(response.data);
      else normalizeCount(response.data, response.status);
      return response;
    };
    if (eligible && this.nativeCollationScopes.has(scope)) {
      parsed.searchParams.set('$filter', plain!);
      try {
        return { response: verified(await request(parsed.toString())), fallback: true };
      } catch (error) {
        this.nativeCollationScopes.delete(scope);
        throw error;
      }
    }
    try {
      return { response: await request(url), fallback: false };
    } catch (error) {
      if (!eligible || !isLowercaseCompatibilityError(error)) throw error;
      parsed.searchParams.set('$filter', plain!);
      try {
        const response = verified(await request(parsed.toString()));
        if (this.nativeCollationScopes.size < 1000)
          this.nativeCollationScopes.set(scope, now + this.config.lookup_cache_ttl * 1000);
        return { response, fallback: true };
      } catch {
        throw error;
      }
    }
  }

  async createRecord<T = Record<string, unknown>>(
    collection: string,
    data: Record<string, unknown>,
    options?: CreateOptions
  ): Promise<T> {
    return (await this.createRecordWithOutcome<T>(collection, data, options)).record;
  }

  async createRecordWithOutcome<T = Record<string, unknown>>(
    collection: string,
    data: Record<string, unknown>,
    options?: CreateOptions
  ): Promise<CreateOutcome<T>> {
    const id = options?.id;
    if (id) {
      assertGuid(id, 'id');
      if (data.Id !== undefined && String(data.Id).toLowerCase() !== id.toLowerCase()) {
        throw new BpmApiError(
          'Id не соответствует идентификатору повторяемой операции.',
          400,
          collection,
          undefined,
          undefined,
          undefined,
          'idempotency_conflict'
        );
      }
      const existing = await this.findCreation<T>(collection, id, data);
      if (existing) return { record: existing, created: false };
    }
    const payload = id ? { ...data, Id: id } : data;
    try {
      const response = await this.httpClient.request<T>({
        method: 'POST',
        url: this.buildCollectionPath(collection),
        body: payload,
        contentKind: 'crud',
        operation: 'mutation',
      });
      const record = unwrapSingle<T>(response.data);
      if (
        id &&
        record &&
        typeof record === 'object' &&
        'Id' in record &&
        String(record.Id).toLowerCase() !== id.toLowerCase()
      ) {
        throw new BpmApiError(
          'Сервер не сохранил переданный UUID. Проверьте созданную запись до повтора.',
          502,
          collection,
          `Полученный UUID: ${String(record.Id)}`,
          undefined,
          ['Найдите созданную запись по полученному UUID; повтор может создать дубль.'],
          'outcome_unknown'
        );
      }
      return {
        record:
          id && record && typeof record === 'object'
            ? { ...record, Id: (record as Record<string, unknown>).Id ?? id }
            : record,
        created: true,
      };
    } catch (error) {
      if (
        id &&
        error instanceof BpmApiError &&
        (error.code === 'outcome_unknown' || [400, 409, 412].includes(error.httpStatus))
      ) {
        try {
          const existing = await this.findCreation<T>(collection, id, data);
          if (existing) return { record: existing, created: null };
        } catch (reconciliationError) {
          if (
            reconciliationError instanceof BpmApiError &&
            reconciliationError.code === 'idempotency_conflict'
          )
            throw reconciliationError;
        }
      }
      throw error;
    }
  }

  private async findCreation<T>(
    collection: string,
    id: string,
    data: Record<string, unknown>
  ): Promise<T | undefined> {
    try {
      const record = await this.getRecord<T>(collection, id);
      const actual = record as Record<string, unknown>;
      if (!Object.entries(data).every(([field, value]) => equivalentValue(actual[field], value))) {
        throw new BpmApiError(
          'Этот idempotency_key уже использован для записи с другими значениями.',
          409,
          collection,
          'Повтор операции допустим только с теми же данными.',
          undefined,
          ['Проверьте существующую запись. Для нового намерения используйте новый ключ.'],
          'idempotency_conflict'
        );
      }
      return record;
    } catch (error) {
      if (error instanceof BpmApiError && error.httpStatus === 404) return undefined;
      throw error;
    }
  }

  /**
   * PATCH записи. С `returnRepresentation` просим сервер вернуть изменённую
   * запись (`Prefer: return=representation`) — иначе BPMSoft отвечает 204, и,
   * чтобы показать модели результат, пришлось бы делать второй GET.
   * Сервер вправе просьбу проигнорировать, поэтому возвращаем `null`, если
   * тела в ответе нет.
   */
  async updateRecord<T = Record<string, unknown>>(
    collection: string,
    id: string,
    data: Record<string, unknown>,
    options?: WriteOptions
  ): Promise<T | null> {
    await this.verifyEtag(collection, id, options);
    const response = await this.httpClient.request<T>({
      method: 'PATCH',
      url: this.buildRecordPath(collection, id),
      body: data,
      contentKind: 'crud',
      operation: 'mutation',
      headers: {
        ...conditionalHeaders(options),
        ...(options?.returnRepresentation ? { Prefer: 'return=representation' } : {}),
      },
    });

    if (response.status === 204) return null;
    const body = response.data as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    return unwrapSingle(body) as T;
  }

  async deleteRecord(collection: string, id: string, options?: WriteOptions): Promise<void> {
    await this.verifyEtag(collection, id, options);
    await this.httpClient.request({
      method: 'DELETE',
      url: this.buildRecordPath(collection, id),
      contentKind: 'crud',
      operation: 'mutation',
      headers: conditionalHeaders(options),
    });
  }

  /** Verify platform support and the current version before assembling a batch mutation. */
  async assertExpectedEtag(collection: string, id: string, expectedEtag: string): Promise<void> {
    return this.verifyEtag(collection, id, { expectedEtag });
  }

  private async verifyEtag(collection: string, id: string, options?: WriteOptions): Promise<void> {
    if (options?.expectedEtag === undefined) return;
    conditionalHeaders(options);
    const current = await this.getRecord<Record<string, unknown>>(collection, id, { $select: 'Id' });
    if (typeof current['@odata.etag'] !== 'string') {
      throw new BpmApiError(
        'Этот сервер BPMSoft не предоставляет ETag; условное изменение не поддерживается.',
        400,
        collection,
        undefined,
        undefined,
        [
          'Получите актуальную запись и проверьте изменения. Не передавайте expected_etag, если осознанно допускаете обычную запись.',
        ],
        'concurrency_unsupported'
      );
    }
    if (current['@odata.etag'] !== options.expectedEtag) {
      throw new BpmApiError('Запись изменилась после чтения.', 412, collection);
    }
  }

  /**
   * Execute a batch request ($batch endpoint, v4 only).
   * Automatically splits into chunks of max_batch_size.
   *
   * NOTE: BPMSoft 1.8 OData v3 endpoint does NOT support $batch (per official
   * Postman collections). For v3 callers we fail fast with a clear error rather
   * than silently 404-ing.
   */
  async executeBatch(
    requests: ClientBatchRequest[],
    continueOnError: boolean = false
  ): Promise<{ responses: ClientBatchResponse[] }> {
    if (this.odataVersion === 3) {
      throw new BpmApiError(
        'Пакетные запросы ($batch) не поддерживаются в режиме OData 3 для BPMSoft 1.8. Используйте OData 4 или выполните операции последовательно.',
        0,
        undefined,
        'odata_version=3',
        undefined,
        [
          'Выполните операции по одной через bpm_create_record/bpm_update_record/bpm_delete_record.',
          'Или переключите подключение на OData v4 (platform=net8), если инстанс это поддерживает.',
        ],
        'batch_unsupported'
      );
    }

    this.validateBulkRequests(requests);
    const wireRequests = requests.map((request) => ({
      ...request,
      body: nativeBatchBody(request.body, request.numericFields),
    }));
    const allResponses: ClientBatchResponse[] = [];
    let stopped = false;
    let globalIndex = 0;
    for (const chunk of chunkArray(wireRequests, this.config.max_batch_size)) {
      const batchRequests = chunk.map((request) => ({
        id: String(++globalIndex),
        method: request.method,
        url: request.url,
        headers: { 'Content-Type': 'application/json', ...request.headers },
        body: request.body,
      }));
      if (stopped) {
        allResponses.push(
          ...batchRequests.map(
            (request): ClientBatchResponse => ({
              id: request.id,
              status: 0,
              body: null,
              state: 'not_executed',
            })
          )
        );
        continue;
      }
      try {
        const response = await this.httpClient.request<{
          responses?: Array<{ id?: string; status: number; body?: unknown }>;
        }>({
          method: 'POST',
          url: `${this.baseUrl}/$batch`,
          body: { requests: batchRequests },
          contentKind: 'batch',
          operation: batchRequests.every((request) => request.method === 'GET') ? 'read' : 'mutation',
          headers: continueOnError ? { Prefer: 'continue-on-error' } : {},
        });
        const byId = new Map<string, { status: number; body?: unknown }>();
        const duplicateIds = new Set<string>();
        for (const item of response.data.responses ?? []) {
          if (item.id && byId.has(item.id)) duplicateIds.add(item.id);
          if (item.id) byId.set(item.id, item);
        }
        const results = batchRequests.map((request): ClientBatchResponse => {
          const item = byId.get(request.id);
          if (!item || duplicateIds.has(request.id) || !Number.isInteger(item.status))
            return { id: request.id, status: 0, body: null, state: 'outcome_unknown' };
          return {
            id: request.id,
            status: item.status,
            body: item.body ?? null,
            state:
              item.status === 424
                ? 'not_executed'
                : item.status >= 200 && item.status < 300
                  ? 'completed'
                  : item.status >= 500 || item.status === 408
                    ? 'outcome_unknown'
                    : 'failed',
          };
        });
        allResponses.push(...results);
        if (
          results.some((item) => item.state === 'outcome_unknown') ||
          (!continueOnError && results.some((item) => item.state !== 'completed'))
        )
          stopped = true;
      } catch (error) {
        const state =
          error instanceof BpmApiError && error.code !== 'outcome_unknown' ? 'failed' : 'outcome_unknown';
        allResponses.push(
          ...batchRequests.map(
            (request): ClientBatchResponse => ({
              id: request.id,
              status: error instanceof BpmApiError ? error.httpStatus : 0,
              body:
                error instanceof BpmApiError
                  ? error.toToolError()
                  : { error: error instanceof Error ? error.message : String(error) },
              state,
            })
          )
        );
        stopped = true;
      }
    }
    return { responses: allResponses };
  }

  /**
   * Пакетное выполнение с выбором пути на стороне сервера.
   *
   * Модель передаёт массив, а как его отправить — решает сервер: одним $batch,
   * если инстанс его переваривает, иначе по одному запросу. Поддержка $batch
   * проверяется безвредным GET внутри $batch по той же
   * коллекции — до того, как в пакет попадут записи: при неудачном пакете с
   * POST неизвестно, что успело создаться, а повтор по одному дал бы дубли.
   * Результат пробы временно кэшируется по подключению, пользователю и коллекции.
   */
  async executeBulk(
    requests: ClientBatchRequest[],
    continueOnError: boolean,
    probeCollectionPath: string
  ): Promise<{ responses: ClientBatchResponse[]; mode: 'batch' | 'single' }> {
    this.validateBulkRequests(requests);
    if (this.odataVersion === 4 && (await this.probeBatch(probeCollectionPath))) {
      return { ...(await this.executeBatch(requests, continueOnError)), mode: 'batch' };
    }
    return { responses: await this.executeOneByOne(requests, continueOnError), mode: 'single' };
  }

  private validateBulkRequests(requests: Array<{ method: string; url: string }>): void {
    for (const request of requests) {
      const url = new URL(request.url, `${this.baseUrl}/`);
      if (
        url.origin !== this.origin ||
        !url.pathname.startsWith(new URL(`${this.baseUrl}/`).pathname) ||
        !['GET', 'POST', 'PATCH', 'DELETE'].includes(request.method)
      ) {
        throw new BpmApiError('Недопустимый адрес или метод пакетной операции.', 400);
      }
    }
  }

  private async probeBatch(collectionPath: string): Promise<boolean> {
    const scope = `${this.baseUrl}|${getAuthCacheScope() || `env:${this.config.username ?? ''}`}|${collectionPath}`;
    const known = getBatchSupport(scope);
    if (known !== undefined) return known;
    try {
      const { responses } = await this.executeBatch([
        { method: 'GET', url: `${collectionPath}?$top=1&$select=Id` },
      ]);
      const status = responses[0]?.status;
      if (status === 401 || status === 403) {
        throw new BpmApiError('Нет доступа к проверке пакетного выполнения.', status);
      }
      const ok = status !== undefined && status >= 200 && status < 300;
      const probeBody = responses[0]?.body as { error?: unknown } | null;
      const unsupported =
        responses[0]?.state === 'failed' &&
        ([400, 404, 405, 415, 501].includes(status!) ||
          isQueryUnsupportedError(new BpmApiError(String(probeBody?.error ?? ''), status ?? 0)));
      if (ok || unsupported) {
        setBatchSupport(ok, ok ? undefined : `ответ пробы: ${status}`, scope);
      }
      return ok;
    } catch (error) {
      // Нет прав или сессии — это не свойство инстанса, латч не трогаем.
      if (error instanceof BpmApiError && (error.httpStatus === 401 || error.httpStatus === 403)) throw error;
      if (
        error instanceof BpmApiError &&
        ([400, 404, 405, 415, 501].includes(error.httpStatus) || isQueryUnsupportedError(error))
      ) {
        setBatchSupport(false, error.message, scope);
      }
      return false;
    }
  }

  /**
   * Запросы по одному. ponytail: строго последовательно — порядок ответов совпадает
   * с порядком массива, а стенд не получает залп запросов; пул параллелизма — если
   * сотни записей по одному станут узким местом.
   */
  private async executeOneByOne(
    requests: ClientBatchRequest[],
    continueOnError: boolean
  ): Promise<ClientBatchResponse[]> {
    const responses: ClientBatchResponse[] = [];
    let stopped = false;
    for (const [i, req] of requests.entries()) {
      const id = String(i + 1);
      if (stopped) {
        responses.push({ id, status: 0, body: null, state: 'not_executed' });
        continue;
      }
      try {
        const res = await this.httpClient.request({
          method: req.method as HttpRequestOptions['method'],
          url: req.url,
          body: req.body,
          headers: req.headers,
          contentKind: 'crud',
        });
        responses.push({ id, status: res.status, body: res.data, state: 'completed' });
      } catch (error) {
        const status = error instanceof BpmApiError ? error.httpStatus : 0;
        const state =
          error instanceof BpmApiError && error.code !== 'outcome_unknown' ? 'failed' : 'outcome_unknown';
        responses.push({
          id,
          status,
          body:
            error instanceof BpmApiError
              ? error.toToolError()
              : { error: error instanceof Error ? error.message : String(error) },
          state,
        });
        if (state === 'outcome_unknown' || !continueOnError || status === 401 || status === 403)
          stopped = true;
      }
    }
    return responses;
  }

  /**
   * Загрузка $metadata с поддержкой условного GET.
   *
   * Документ большой (на типовом стенде 2.5 МБ и несколько секунд), поэтому
   * при наличии сохранённого ETag просим сервер ответить 304 и переиспользуем
   * то, что уже лежит на диске.
   */
  async getMetadataXml(options: { etag?: string } = {}): Promise<MetadataFetchResult> {
    const url = `${this.baseUrl}/$metadata`;
    const response = await this.httpClient.request<string>({
      method: 'GET',
      url,
      contentKind: 'metadata',
      responseType: 'text',
      headers: options.etag ? { 'If-None-Match': options.etag } : undefined,
    });

    if (response.status === 304) {
      return { xml: '', etag: options.etag, notModified: true };
    }
    return {
      xml: String(response.data),
      etag: response.headers?.etag ?? response.headers?.ETag,
      notModified: false,
    };
  }

  // Binary field I/O (per Postman "Поток данных")

  /**
   * PUT raw bytes into an entity field.
   * Named streams use /FieldName; primitive binary values use /FieldName/$value.
   */
  async putFieldBinary(
    collection: string,
    id: string,
    field: string,
    data: Buffer | Uint8Array,
    options?: BinaryFieldOptions
  ): Promise<void> {
    const url = this.buildBinaryFieldUrl(collection, id, field, 'PUT', options);
    await this.httpClient.request({
      method: 'PUT',
      url,
      body: data,
      contentKind: 'binary',
    });
  }

  /**
   * GET raw bytes from an entity field.
   * Explicit EDM type takes precedence over the legacy version-based route.
   */
  async getFieldBinary(
    collection: string,
    id: string,
    field: string,
    options?: BinaryFieldOptions
  ): Promise<Buffer> {
    const url = this.buildBinaryFieldUrl(collection, id, field, 'GET', options);
    const response = await this.httpClient.request<Buffer>({
      method: 'GET',
      url,
      contentKind: 'binary',
      responseType: 'binary',
    });
    return response.data;
  }

  /** DELETE binary content of an entity field. */
  async deleteFieldBinary(
    collection: string,
    id: string,
    field: string,
    options?: BinaryFieldOptions
  ): Promise<void> {
    const url = this.buildBinaryFieldUrl(collection, id, field, 'DELETE', options);
    await this.httpClient.request({
      method: 'DELETE',
      url,
      contentKind: 'binary',
    });
  }

  private buildBinaryFieldUrl(
    collection: string,
    id: string,
    field: string,
    method: 'GET' | 'PUT' | 'DELETE',
    options?: BinaryFieldOptions
  ): string {
    assertSafeIdentifier(field, 'field');
    const url = `${this.buildRecordPath(collection, id)}/${encodeURIComponent(field)}`;
    if (options?.fieldType === 'Edm.Binary') return `${url}/$value`;
    if (options?.fieldType === 'Edm.Stream') return url;
    return method === 'GET' && this.odataVersion === 3 ? `${url}/$value` : url;
  }

  /** Preview the native query without issuing a request. */
  previewCollectionUrl(collection: string, query?: QueryOptions): string {
    return this.buildCollectionUrl(collection, query);
  }

  private buildCollectionUrl(collection: string, query?: QueryOptions): string {
    const base = this.buildCollectionPath(collection);
    const params = this.buildQueryParams(query);
    return params ? `${base}?${params}` : base;
  }

  private buildRecordUrl(
    collection: string,
    id: string,
    query?: Pick<QueryOptions, '$select' | '$expand'>
  ): string {
    const base = this.buildRecordPath(collection, id);
    const params = this.buildQueryParams(query);
    return params ? `${base}?${params}` : base;
  }

  buildCollectionPath(collection: string): string {
    assertSafeIdentifier(collection, 'collection');
    const collectionName = this.odataVersion === 3 ? this.ensureCollectionSuffix(collection) : collection;
    return `${this.baseUrl}/${collectionName}`;
  }

  buildRecordPath(collection: string, id: string): string {
    assertGuid(id, 'id');
    const collectionPath = this.buildCollectionPath(collection);
    return this.odataVersion === 3 ? `${collectionPath}(guid'${id}')` : `${collectionPath}(${id})`;
  }

  /** Origin to which all requests must stay locked. Exposed for diagnostics/tests. */
  getOrigin(): string {
    return this.origin;
  }

  private buildQueryParams(query?: QueryOptions | Pick<QueryOptions, '$select' | '$expand'>): string {
    if (!query) return '';
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      if (key === '$count') {
        if (value !== true) continue;
        params.set(
          this.odataVersion === 3 ? '$inlinecount' : '$count',
          this.odataVersion === 3 ? 'allpages' : 'true'
        );
      } else {
        params.set(key, String(value));
      }
    }
    return params.toString();
  }

  private ensureCollectionSuffix(name: string): string {
    return name.endsWith('Collection') ? name : `${name}Collection`;
  }

  /**
   * Resolve nextLink to a full URL.
   *
   * Same-origin enforcement is applied at the HttpClient layer (setAllowedOrigin),
   * so an absolute URL pointing elsewhere will throw before any request is made.
   */
  private validateNextLink(collection: string, link: string): string {
    const expected = new URL(this.buildCollectionPath(collection));
    const url = new URL(link, link.startsWith('?') ? expected.toString() : `${this.baseUrl}/`);
    if (url.origin !== this.origin || url.pathname !== expected.pathname || url.username || url.password) {
      throw new BpmApiError('Ссылка продолжения не соответствует исходной коллекции.', 400, collection);
    }
    if (url.hash && !/^#mcp-offset=\d+$/.test(url.hash))
      throw new BpmApiError('Некорректная ссылка продолжения.', 400, collection);
    return url.toString();
  }
}

const COLLATION_WARNING =
  'BPMSoft не выполнил tolower; поиск использует исходное поле и коллацию платформы для сравнения регистра.';

function isLowercaseCompatibilityError(error: unknown): boolean {
  if (!(error instanceof BpmApiError)) return false;
  if (error.code === 'network' && error.httpStatus === 0 && /\bterminated\b/i.test(error.message))
    return true;
  return (
    [400, 501].includes(error.httpStatus) &&
    /\btolower\b/i.test(error.message) &&
    /unsupported|not\s+(?:implemented|supported)|not.*support|unknown\s+function|unrecognized\s+function|не.*поддерж|неизвестн.*функц/i.test(
      error.message
    )
  );
}

/** Remove only actual tolower(field/path) calls, preserving quoted literals and doubled quote escaping. */
export function removeLowercaseFunctions(filter: string): string {
  let result = '';
  let quoted = false;
  for (let index = 0; index < filter.length; ) {
    const char = filter[index];
    if (char === "'") {
      result += char;
      index++;
      if (quoted && filter[index] === "'") {
        result += "'";
        index++;
      } else quoted = !quoted;
      continue;
    }
    if (!quoted && (index === 0 || !/[\w/.$]/.test(filter[index - 1]))) {
      const match = /^tolower\s*\(\s*([A-Za-z_][A-Za-z0-9_]*(?:\/[A-Za-z_][A-Za-z0-9_]*)*)\s*\)/i.exec(
        filter.slice(index)
      );
      if (match) {
        result += match[1];
        index += match[0].length;
        continue;
      }
    }
    result += char;
    index++;
  }
  return result;
}

function normalizeCount(raw: unknown, status: number, collection?: string): number {
  const text = String(raw).trim();
  const count = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(count))
    throw new BpmApiError(`Невалидный ответ $count: ${String(raw)}`, status, collection);
  return count;
}

function normalizeCollection<T>(raw: unknown): ODataCollectionResponse<T> {
  if (!raw || typeof raw !== 'object') throw new BpmApiError('Сервер вернул некорректный список OData.', 502);
  const outer = raw as Record<string, unknown>;
  const value = (outer.d && typeof outer.d === 'object' ? outer.d : outer) as Record<string, unknown>;
  const rows = value.value ?? value.results;
  if (!Array.isArray(rows)) throw new BpmApiError('В ответе OData отсутствует массив записей.', 502);
  const result: ODataCollectionResponse<T> = { value: rows as T[] };
  if (typeof value['@odata.context'] === 'string') result['@odata.context'] = value['@odata.context'];
  const next = value['@odata.nextLink'] ?? value.__next;
  if (typeof next === 'string' && next) result['@odata.nextLink'] = next;
  const count = value['@odata.count'] ?? value.__count;
  if (count !== undefined && /^\d+$/.test(String(count)) && Number.isSafeInteger(Number(count)))
    result['@odata.count'] = Number(count);
  return result;
}

function unwrapSingle<T>(raw: T): T {
  if (raw && typeof raw === 'object' && 'd' in raw && raw.d && typeof raw.d === 'object') return raw.d as T;
  return raw;
}

function validateLimit(limit?: number): number {
  if (limit === undefined) return Infinity;
  if (!Number.isSafeInteger(limit) || limit <= 0)
    throw new BpmApiError('maxRecords должен быть положительным целым числом.', 400);
  return limit;
}

function stableOrder(order?: string): string {
  if (!order) return 'Id asc';
  return order.split(',').some((entry) => /^Id(?:\s+(?:asc|desc))?$/i.test(entry.trim()))
    ? order
    : `${order},Id asc`;
}

function offsetContinuation(url: string, skip: number): string {
  const next = new URL(url);
  next.hash = '';
  next.searchParams.delete('$skiptoken');
  next.searchParams.set('$skip', String(skip));
  next.searchParams.set('$orderby', stableOrder(next.searchParams.get('$orderby') ?? undefined));
  return next.toString();
}

/** Build a continuation at an offset within the current query page. */
export function continuationAfter(url: string, offset: number): string {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Некорректное смещение продолжения');
  const parsed = new URL(url);
  if (parsed.searchParams.has('$skiptoken')) return withPageOffset(url, offset);
  return offsetContinuation(url, Number(parsed.searchParams.get('$skip') ?? 0) + offset);
}

/** Get the exact continuation after a prefix of an aggregated OData response. */
export function continuationForResult(response: object, returnedCount: number, fallbackUrl: string): string {
  const boundaries = pageBoundariesByResponse.get(response);
  const boundary = boundaries?.find((page) => returnedCount > page.start && returnedCount <= page.end);
  if (!boundary) return continuationAfter(fallbackUrl, returnedCount);
  const pageOffset = returnedCount - boundary.start;
  return pageOffset === boundary.end - boundary.start
    ? (boundary.continuation ?? continuationAfter(boundary.url, pageOffset))
    : continuationAfter(boundary.url, pageOffset);
}

function withPageOffset(url: string, offset: number): string {
  const next = new URL(url);
  const current = next.hash.startsWith('#mcp-offset=') ? Number(next.hash.slice(12)) : 0;
  next.hash = `mcp-offset=${current + offset}`;
  return next.toString();
}

function conditionalHeaders(options?: WriteOptions): Record<string, string> | undefined {
  if (options?.expectedEtag === undefined) return undefined;
  if (!/^(?:W\/)?"[^"\r\n]+"$/.test(options.expectedEtag))
    throw new BpmApiError('expected_etag должен быть конкретной версией записи.', 400);
  return { 'If-Match': options.expectedEtag };
}

function equivalentValue(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (typeof expected === 'number' && typeof actual === 'string' && /^-?\d+(?:\.\d+)?$/.test(actual))
    return Number(actual) === expected;
  if (typeof actual === 'string' && typeof expected === 'string') {
    if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(actual) && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(expected))
      return actual.toLowerCase() === expected.toLowerCase();
    if (/^\d{4}-\d{2}-\d{2}T/.test(actual) && /^\d{4}-\d{2}-\d{2}T/.test(expected))
      return Date.parse(actual) === Date.parse(expected);
  }
  return false;
}

function chunkArray<T>(array: T[], chunkSize: number): T[][] {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1)
    throw new BpmApiError('Некорректный размер пакетного запроса.', 400);
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}

function nativeBatchBody(
  body: Record<string, unknown> | undefined,
  numericFields: readonly string[] = []
): Record<string, unknown> | undefined {
  if (!body || !numericFields.length) return body;
  const rawJSON = (JSON as typeof JSON & { rawJSON?: (value: string) => unknown }).rawJSON;
  if (!rawJSON)
    throw new BpmApiError('Для точных чисел в пакетных запросах требуется Node.js с JSON.rawJSON.', 400);
  const wire = { ...body };
  for (const field of numericFields) {
    assertSafeIdentifier(field, 'numericField');
    const value = body[field];
    if (value === undefined || value === null) continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
        throw new BpmApiError(`Поле ${field}: передайте точное число строкой.`, 400);
      continue;
    }
    if (typeof value !== 'string') throw new BpmApiError(`Поле ${field}: ожидается числовое значение.`, 400);
    // Convert validated Decimal/Int64 text to a JSON number token without using
    // Number: the native batch endpoint rejects IEEE754-compatible decimal strings.
    const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))([eE][+-]?\d+)?$/.exec(value.trim());
    if (!match) throw new BpmApiError(`Поле ${field}: ожидается числовое значение.`, 400);
    const [, sign, integer, fraction, leadingFraction, exponent] = match;
    const whole = (integer ?? '0').replace(/^0+(?=\d)/, '');
    const decimal = fraction ?? leadingFraction;
    wire[field] = rawJSON(
      `${sign === '-' ? '-' : ''}${whole}${decimal ? `.${decimal}` : ''}${exponent ?? ''}`
    );
  }
  return wire;
}
