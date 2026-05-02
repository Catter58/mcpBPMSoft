/**
 * OData Client for BPMSoft
 *
 * High-level OData operations built on top of HttpClient.
 * Handles URL construction, query parameters, pagination,
 * binary field I/O, and response normalization.
 */

import type {
  BpmConfig,
  HttpResponse,
  ODataCollectionResponse,
  ODataVersion,
} from '../types/index.js';
import { HttpClient } from './http-client.js';
import { getODataBaseUrl } from '../config.js';
import { BpmApiError } from '../utils/errors.js';

export interface QueryOptions {
  $filter?: string;
  $select?: string;
  $top?: number;
  $skip?: number;
  $orderby?: string;
  $expand?: string;
  $count?: boolean;
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
    const url = this.buildCollectionUrl(collection, query);
    const response = await this.httpClient.request<ODataCollectionResponse<T>>({
      method: 'GET',
      url,
      contentKind: 'crud',
    });

    const result = response.data;
    const limit = maxRecords ?? Infinity;

    if (autoPaginate) {
      let nextLink = pickNextLink(result);
      while (nextLink && result.value.length < limit) {
        const nextUrl = this.resolveNextLink(nextLink);
        const next: HttpResponse<ODataCollectionResponse<T>> = await this.httpClient.request<ODataCollectionResponse<T>>({
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

  async updateRecord(
    collection: string,
    id: string,
    data: Record<string, unknown>
  ): Promise<void> {
    const url = this.buildRecordPath(collection, id);
    await this.httpClient.request({
      method: 'PATCH',
      url,
      body: data,
      contentKind: 'crud',
    });
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
        'odata_version=3'
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

  /** Fetch OData $metadata XML document */
  async getMetadataXml(): Promise<string> {
    const url = `${this.baseUrl}/$metadata`;
    const response = await this.httpClient.request<string>({
      method: 'GET',
      url,
      contentKind: 'metadata',
      responseType: 'text',
    });
    return String(response.data);
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
  async getFieldBinary(
    collection: string,
    id: string,
    field: string
  ): Promise<Buffer> {
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
    const collectionName = this.odataVersion === 3 ? this.ensureCollectionSuffix(collection) : collection;
    return `${this.baseUrl}/${collectionName}`;
  }

  buildRecordPath(collection: string, id: string): string {
    const collectionPath = this.buildCollectionPath(collection);
    return this.odataVersion === 3
      ? `${collectionPath}(guid'${id}')`
      : `${collectionPath}(${id})`;
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
