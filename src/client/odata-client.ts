/**
 * OData Client for BPMSoft
 *
 * High-level OData operations built on top of HttpClient.
 * Handles URL construction, query parameters, pagination,
 * binary field I/O, and response normalization.
 */

import type {
  BpmConfig,
  HttpRequestOptions,
  HttpResponse,
  ODataCollectionResponse,
  ODataVersion,
} from '../types/index.js';
import { HttpClient } from './http-client.js';
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

export class ODataClient {
  private baseUrl: string;
  private origin: string;
  private odataVersion: ODataVersion;

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
    let response: HttpResponse<ODataCollectionResponse<T>>;
    try {
      response = await this.httpClient.request<ODataCollectionResponse<T>>({
        method: 'GET',
        url: this.buildCollectionUrl(collection, query),
        contentKind: 'crud',
      });
    } catch (error) {
      if (query?.$count !== true || !isQueryUnsupportedError(error)) throw error;
      // bpm9: $count=true вместе с $filter по guid-колонке рвёт поток (200, 0 байт).
      // Берём страницу без $count, а итог — отдельным /$count, если сервер его осилит.
      response = await this.httpClient.request<ODataCollectionResponse<T>>({
        method: 'GET',
        url: this.buildCollectionUrl(collection, { ...query, $count: undefined }),
        contentKind: 'crud',
      });
      let countNote: string;
      try {
        const total = await this.getCount(collection, query.$filter);
        response.data['@odata.count'] = total;
        countNote = `итог получен через /$count: ${total}`;
      } catch (countError) {
        countNote = `/$count тоже не сработал (${countError instanceof Error ? countError.message : String(countError)}), итог не указан`;
      }
      console.error(
        `[ODataClient] ${collection}: $count=true отвергнут (${error instanceof Error ? error.message : String(error)}), страница получена без $count; ${countNote}`
      );
    }

    const result = response.data;
    const limit = maxRecords ?? Infinity;

    if (autoPaginate) {
      let nextLink = pickNextLink(result);
      while (nextLink && result.value.length < limit) {
        const nextUrl = this.resolveNextLink(nextLink);
        const next: HttpResponse<ODataCollectionResponse<T>> = await this.httpClient.request<
          ODataCollectionResponse<T>
        >({
          method: 'GET',
          url: nextUrl,
          contentKind: 'crud',
        });
        result.value.push(...next.data.value);
        nextLink = pickNextLink(next.data);
        if (nextLink) {
          // expose latest nextLink so callers can continue if hit maxRecords
          result['@odata.nextLink'] = nextLink;
        } else {
          delete result['@odata.nextLink'];
        }
      }
      if (result.value.length > limit) {
        result.value = result.value.slice(0, limit);
      }
    }

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
    return response.data;
  }

  /** Get record count */
  async getCount(collection: string, filter?: string): Promise<number> {
    const params = new URLSearchParams();
    if (filter) params.set('$filter', filter);
    const url = `${this.buildCollectionPath(collection)}/$count${params.toString() ? '?' + params.toString() : ''}`;
    const response = await this.httpClient.request<string>({
      method: 'GET',
      url,
      contentKind: 'count',
      responseType: 'text',
    });
    const count = parseInt(String(response.data).trim(), 10);
    if (isNaN(count)) {
      throw new BpmApiError(`Невалидный ответ $count: ${response.data}`, response.status, collection);
    }
    return count;
  }

  async createRecord<T = Record<string, unknown>>(
    collection: string,
    data: Record<string, unknown>
  ): Promise<T> {
    const url = this.buildCollectionPath(collection);
    const response = await this.httpClient.request<T>({
      method: 'POST',
      url,
      body: data,
      contentKind: 'crud',
    });
    return response.data;
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
    options: { returnRepresentation?: boolean } = {}
  ): Promise<T | null> {
    const url = this.buildRecordPath(collection, id);
    const response = await this.httpClient.request<T>({
      method: 'PATCH',
      url,
      body: data,
      contentKind: 'crud',
      headers: options.returnRepresentation ? { Prefer: 'return=representation' } : undefined,
    });

    if (response.status === 204) return null;
    const body = response.data as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    return body as T;
  }

  async deleteRecord(collection: string, id: string): Promise<void> {
    const url = this.buildRecordPath(collection, id);
    await this.httpClient.request({
      method: 'DELETE',
      url,
      contentKind: 'crud',
    });
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
    requests: Array<{
      method: string;
      url: string;
      headers?: Record<string, string>;
      body?: Record<string, unknown>;
    }>,
    continueOnError: boolean = false
  ): Promise<{ responses: Array<{ id?: string; status: number; body: unknown }> }> {
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

    const batchUrl = `${this.baseUrl}/$batch`;
    const chunks = chunkArray(requests, this.config.max_batch_size);
    const allResponses: Array<{ id?: string; status: number; body: unknown }> = [];

    let globalIndex = 0;
    for (const chunk of chunks) {
      const batchBody = {
        requests: chunk.map((req) => ({
          id: String(++globalIndex),
          method: req.method,
          url: req.url,
          headers: {
            'Content-Type': 'application/json; odata=verbose; IEEE754Compatible=true',
            ...req.headers,
          },
          body: req.body,
        })),
      };

      const headers: Record<string, string> = {};
      if (continueOnError) headers['Prefer'] = 'continue-on-error';

      const response = await this.httpClient.request<{
        responses: Array<{ id?: string; status: number; body: unknown }>;
      }>({
        method: 'POST',
        url: batchUrl,
        body: batchBody,
        contentKind: 'batch',
        headers,
      });

      allResponses.push(...(response.data.responses || []));
    }

    return { responses: allResponses };
  }

  /**
   * Пакетное выполнение с выбором пути на стороне сервера.
   *
   * Модель передаёт массив, а как его отправить — решает сервер: одним $batch,
   * если инстанс его переваривает, иначе по одному запросу. Поддержка $batch
   * проверяется один раз на процесс безвредным GET внутри $batch по той же
   * коллекции — до того, как в пакет попадут записи: при неудачном пакете с
   * POST неизвестно, что успело создаться, а повтор по одному дал бы дубли.
   */
  async executeBulk(
    requests: Array<{ method: HttpRequestOptions['method']; url: string; body?: Record<string, unknown> }>,
    continueOnError: boolean,
    probeCollectionPath: string
  ): Promise<{ responses: Array<{ id?: string; status: number; body: unknown }>; mode: 'batch' | 'single' }> {
    if (this.odataVersion === 4 && (await this.probeBatch(probeCollectionPath))) {
      return { ...(await this.executeBatch(requests, continueOnError)), mode: 'batch' };
    }
    return { responses: await this.executeOneByOne(requests, continueOnError), mode: 'single' };
  }

  private async probeBatch(collectionPath: string): Promise<boolean> {
    const known = getBatchSupport();
    if (known !== undefined) return known;
    try {
      const { responses } = await this.executeBatch([
        { method: 'GET', url: `${collectionPath}?$top=1&$select=Id` },
      ]);
      const status = responses[0]?.status;
      const ok = status !== undefined && status >= 200 && status < 300;
      setBatchSupport(ok, ok ? undefined : `ответ пробы: ${status ?? 'без responses'}`);
      return ok;
    } catch (error) {
      // Нет прав или сессии — это не свойство инстанса, латч не трогаем.
      if (error instanceof BpmApiError && (error.httpStatus === 401 || error.httpStatus === 403)) throw error;
      setBatchSupport(false, error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  /**
   * Запросы по одному. ponytail: строго последовательно — порядок ответов совпадает
   * с порядком массива, а стенд не получает залп запросов; пул параллелизма — если
   * сотни записей по одному станут узким местом.
   */
  private async executeOneByOne(
    requests: Array<{ method: HttpRequestOptions['method']; url: string; body?: Record<string, unknown> }>,
    continueOnError: boolean
  ): Promise<Array<{ id?: string; status: number; body: unknown }>> {
    const responses: Array<{ id?: string; status: number; body: unknown }> = [];
    for (const [i, req] of requests.entries()) {
      try {
        const res = await this.httpClient.request({
          method: req.method,
          url: req.url,
          body: req.body,
          contentKind: 'crud',
        });
        responses.push({ id: String(i + 1), status: res.status, body: res.data });
      } catch (error) {
        if (error instanceof BpmApiError && error.httpStatus === 401) throw error;
        const status = error instanceof BpmApiError ? error.httpStatus : 0;
        const message = error instanceof Error ? error.message : String(error);
        responses.push({ id: String(i + 1), status, body: { error: message } });
        if (!continueOnError) break;
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
   * URL: {baseUrl}/{Collection}({id})/{FieldName}
   */
  async putFieldBinary(
    collection: string,
    id: string,
    field: string,
    data: Buffer | Uint8Array
  ): Promise<void> {
    const url = `${this.buildRecordPath(collection, id)}/${encodeURIComponent(field)}`;
    await this.httpClient.request({
      method: 'PUT',
      url,
      body: data,
      contentKind: 'binary',
    });
  }

  /**
   * GET raw bytes from an entity field.
   * URL: {baseUrl}/{Collection}({id})/{FieldName}
   * For OData 3 the canonical $value form is also used: /FieldName/$value
   */
  async getFieldBinary(collection: string, id: string, field: string): Promise<Buffer> {
    const fieldUrl = `${this.buildRecordPath(collection, id)}/${encodeURIComponent(field)}`;
    const url = this.odataVersion === 3 ? `${fieldUrl}/$value` : fieldUrl;
    const response = await this.httpClient.request<Buffer>({
      method: 'GET',
      url,
      contentKind: 'binary',
      responseType: 'binary',
    });
    return response.data;
  }

  /** DELETE binary content of an entity field. */
  async deleteFieldBinary(collection: string, id: string, field: string): Promise<void> {
    const url = `${this.buildRecordPath(collection, id)}/${encodeURIComponent(field)}`;
    await this.httpClient.request({
      method: 'DELETE',
      url,
      contentKind: 'binary',
    });
  }

  /**
   * URL, который ушёл бы на сервер, без выполнения запроса.
   * Нужен для dry_run: модель видит, во что превратились её критерии, и может
   * поправиться сама, не тратя round-trip и не задевая данные.
   */
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
      if (key === '$count' && value === true) {
        params.set('$count', 'true');
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
  private resolveNextLink(link: string): string {
    if (link.startsWith('http://') || link.startsWith('https://')) {
      return link;
    }
    if (link.startsWith('/')) {
      return `${this.origin}${link}`;
    }
    return `${this.baseUrl}/${link}`;
  }
}

function pickNextLink<T>(resp: ODataCollectionResponse<T>): string | undefined {
  if (resp['@odata.nextLink']) return resp['@odata.nextLink'];
  // OData v3 returns __next on the envelope
  const v3 = resp as unknown as { __next?: string };
  if (typeof v3.__next === 'string') return v3.__next;
  return undefined;
}

function chunkArray<T>(array: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}
