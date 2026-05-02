/**
 * HTTP Client for BPMSoft API
 *
 * Wraps native fetch with BPMSoft-specific concerns:
 * - Cookie management (BPMSESSIONID and other cookies)
 * - Automatic BPMCSRF header injection
 * - ForceUseSession: true on every authenticated request
 * - Context-aware Content-Type/Accept by `contentKind`
 * - Binary I/O (Buffer/Uint8Array bodies, binary responses)
 * - Same-origin enforcement (must be set explicitly via setAllowedOrigin)
 * - Retry with exponential backoff for 5xx
 * - Retry honoring Retry-After for 429/503
 * - Auto-reauthentication on 401/403 (single attempt)
 * - Optional debug logging via BPMSOFT_DEBUG=1|trace with secret masking
 */

import type {
  BpmConfig,
  HttpRequestOptions,
  HttpResponse,
  AuthState,
} from '../types/index.js';
import { BpmApiError, parseODataError } from '../utils/errors.js';

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;
const MAX_RETRY_AFTER_SECONDS = 60; // hard cap to avoid pathological waits

export class HttpClient {
  private authState: AuthState = {
    sessionId: null,
    csrfToken: null,
    cookies: new Map(),
    isAuthenticated: false,
  };

  private reauthHandler: (() => Promise<void>) | null = null;
  private isReauthenticating = false;
  private allowedOrigin: string | null = null;

  private readonly debugMode: 'off' | 'on' | 'trace';

  constructor(private config: BpmConfig) {
    const dbg = (process.env.BPMSOFT_DEBUG || '').toLowerCase();
    this.debugMode = dbg === 'trace' ? 'trace' : dbg === '1' || dbg === 'true' || dbg === 'on' ? 'on' : 'off';
  }

  /**
   * Limit which origin the client will follow (used by ODataClient to lock to BPMSoft origin).
   * Any subsequent request whose URL has a different origin throws BpmApiError.
   */
  setAllowedOrigin(origin: string): void {
    this.allowedOrigin = origin;
  }

  setReauthHandler(handler: () => Promise<void>): void {
    this.reauthHandler = handler;
  }

  updateAuthState(state: Partial<AuthState>): void {
    if (state.sessionId !== undefined) this.authState.sessionId = state.sessionId;
    if (state.csrfToken !== undefined) this.authState.csrfToken = state.csrfToken;
    if (state.isAuthenticated !== undefined) this.authState.isAuthenticated = state.isAuthenticated;
    if (state.cookies) {
      for (const [key, value] of state.cookies) {
        this.authState.cookies.set(key, value);
      }
    }
  }

  getAuthState(): AuthState {
    return { ...this.authState };
  }

  /**
   * Perform an HTTP request with all BPMSoft-specific handling
   */
  async request<T = unknown>(options: HttpRequestOptions): Promise<HttpResponse<T>> {
    this.assertAllowedOrigin(options.url);
    return this.requestWithRetry<T>(options, 0);
  }

  private async requestWithRetry<T>(
    options: HttpRequestOptions,
    attempt: number
  ): Promise<HttpResponse<T>> {
    const headers = this.buildHeaders(options);
    const cookieStr = this.buildCookieString();
    if (cookieStr) headers['Cookie'] = cookieStr;

    const controller = new AbortController();
    const timeout = options.timeout ?? this.config.request_timeout;
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const startedAt = Date.now();
    try {
      const fetchOptions: RequestInit = {
        method: options.method,
        headers,
        signal: controller.signal,
        redirect: 'follow',
      };

      if (options.body !== undefined && options.body !== null && options.method !== 'GET') {
        fetchOptions.body = this.encodeBody(options.body, headers);
      }

      this.logRequest(options, headers);

      const response = await fetch(options.url, fetchOptions);

      this.extractCookies(response);

      const data = await this.decodeBody<T>(response, options);

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      const httpResponse: HttpResponse<T> = {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        data,
        ok: response.ok,
      };

      this.logResponse(options, httpResponse, Date.now() - startedAt);

      // 401/403: try reauth once
      if ((response.status === 401 || response.status === 403) && !options.skipAuth) {
        return this.handleAuthFailure<T>(options, httpResponse);
      }

      // 429 / 503 with Retry-After
      if ((response.status === 429 || response.status === 503) && attempt < MAX_RETRIES) {
        const delayMs = this.parseRetryAfter(responseHeaders['retry-after']) ?? RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        console.error(
          `[HttpClient] ${response.status} on ${options.method} ${shortUrl(options.url)}, retrying in ${delayMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`
        );
        await sleep(delayMs);
        return this.requestWithRetry<T>(options, attempt + 1);
      }

      // 5xx (other than 503): exponential backoff
      if (response.status >= 500 && response.status !== 503 && attempt < MAX_RETRIES) {
        const delayMs = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        console.error(
          `[HttpClient] 5xx (${response.status}) on ${options.method} ${shortUrl(options.url)}, retrying in ${delayMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`
        );
        await sleep(delayMs);
        return this.requestWithRetry<T>(options, attempt + 1);
      }

      if (!response.ok) {
        const odataError = parseODataError(data);
        throw new BpmApiError(
          odataError || `HTTP ${response.status}: ${response.statusText}`,
          response.status,
          undefined,
          odataError
        );
      }

      return httpResponse;
    } catch (error) {
      if (error instanceof BpmApiError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new BpmApiError(`Превышен таймаут запроса (${timeout}ms)`, 408);
      }
      throw new BpmApiError(
        `Сетевая ошибка: ${error instanceof Error ? error.message : String(error)}`,
        0
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Build request headers based on contentKind, version, and per-request overrides.
   *
   * BPMSoft Content-Type contract (from official Postman collections):
   *   auth:    application/json; charset=utf-8 (v4) or application/json; odata=verbose (v3)
   *   crud-v4: application/json
   *   crud-v3: application/json; odata=verbose
   *   batch:   application/json; odata=verbose; IEEE754Compatible=true
   *   binary:  application/octet-stream; IEEE754Compatible=true
   */
  private buildHeaders(options: HttpRequestOptions): Record<string, string> {
    const v3 = this.config.odata_version === 3;
    const kind = options.contentKind ?? 'crud';

    let contentType: string;
    let accept: string;

    switch (kind) {
      case 'auth':
        contentType = v3 ? 'application/json; odata=verbose' : 'application/json; charset=utf-8';
        accept = v3 ? 'application/atom+xml; type=entry' : 'application/json';
        break;
      case 'batch':
        contentType = 'application/json; odata=verbose; IEEE754Compatible=true';
        accept = 'application/json';
        break;
      case 'binary':
        contentType = 'application/octet-stream; IEEE754Compatible=true';
        accept = 'application/json; text/plain; */*';
        break;
      case 'metadata':
        contentType = 'application/json';
        accept = 'application/xml';
        break;
      case 'count':
        contentType = 'application/json';
        accept = 'text/plain';
        break;
      case 'crud':
      default:
        contentType = v3 ? 'application/json; odata=verbose' : 'application/json';
        accept = v3 ? 'application/json; odata=verbose' : 'application/json';
        break;
    }

    const headers: Record<string, string> = {
      'Content-Type': contentType,
      Accept: accept,
      ...options.headers,
    };

    if (!options.skipAuth) {
      if (this.authState.csrfToken) {
        headers['BPMCSRF'] = this.authState.csrfToken;
      }
      headers['ForceUseSession'] = 'true';
    }

    return headers;
  }

  /**
   * Encode body for fetch:
   * - Buffer / Uint8Array / ArrayBuffer / Blob — pass through unchanged
   * - string — pass through unchanged
   * - object — JSON.stringify
   *
   * Honors Content-Type: if binary, never JSON-stringify.
   */
  private encodeBody(body: unknown, headers: Record<string, string>): BodyInit {
    if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
      return body as BodyInit;
    }
    // Node Buffer is a Uint8Array subclass, but we keep an explicit check for clarity.
    if (typeof Buffer !== 'undefined' && body instanceof Buffer) {
      return body as unknown as BodyInit;
    }
    if (typeof Blob !== 'undefined' && body instanceof Blob) {
      return body;
    }
    if (typeof body === 'string') {
      return body;
    }

    const ct = (headers['Content-Type'] || '').toLowerCase();
    if (ct.startsWith('application/octet-stream') || ct.startsWith('multipart/')) {
      // Caller asked for a binary/multipart Content-Type but body is not binary.
      // Fail loudly rather than silently JSON-encoding (the original P0 bug).
      throw new BpmApiError(
        `Тело запроса должно быть Buffer/Uint8Array для Content-Type: ${ct}, получено: ${typeof body}`,
        0
      );
    }

    return JSON.stringify(body);
  }

  /**
   * Decode response body based on requested responseType / Content-Type.
   * - 'binary' → Buffer
   * - 'text' → string
   * - 'json' → parsed JSON (or empty object on 204)
   * - default — auto: prefers JSON when content-type indicates so, otherwise text
   */
  private async decodeBody<T>(response: Response, options: HttpRequestOptions): Promise<T> {
    if (response.status === 204) {
      return {} as T;
    }

    const responseType = options.responseType ?? 'auto';
    if (responseType === 'binary') {
      const buf = await response.arrayBuffer();
      return Buffer.from(buf) as unknown as T;
    }
    if (responseType === 'text') {
      return (await response.text()) as unknown as T;
    }
    if (responseType === 'json') {
      const text = await response.text();
      return (text ? JSON.parse(text) : {}) as T;
    }

    // auto
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('application/json') || contentType.includes('odata')) {
      const text = await response.text();
      return (text ? JSON.parse(text) : {}) as T;
    }
    if (contentType.includes('application/octet-stream') || contentType.includes('image/') || contentType.includes('application/pdf')) {
      const buf = await response.arrayBuffer();
      return Buffer.from(buf) as unknown as T;
    }
    return (await response.text()) as unknown as T;
  }

  private async handleAuthFailure<T>(
    options: HttpRequestOptions,
    failedResponse: HttpResponse<T>
  ): Promise<HttpResponse<T>> {
    if (this.isReauthenticating || !this.reauthHandler) {
      throw new BpmApiError(
        'Аутентификация не удалась. Проверьте учётные данные.',
        failedResponse.status,
        undefined,
        'Повторная аутентификация невозможна'
      );
    }

    this.isReauthenticating = true;
    try {
      console.error('[HttpClient] Auth failed, attempting reauthentication...');
      await this.reauthHandler();
      console.error('[HttpClient] Reauthentication successful, retrying request');
      return this.requestWithRetry<T>(options, 0);
    } catch (error) {
      throw new BpmApiError(
        'Повторная аутентификация не удалась',
        401,
        undefined,
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      this.isReauthenticating = false;
    }
  }

  private extractCookies(response: Response): void {
    // Node 18+ provides getSetCookie(); fall back to single header otherwise.
    const setCookies =
      typeof (response.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === 'function'
        ? (response.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
        : (response.headers.get('set-cookie') ? [response.headers.get('set-cookie') as string] : []);

    for (const cookie of setCookies) {
      const [nameValue] = cookie.split(';');
      if (!nameValue) continue;
      const eqIndex = nameValue.indexOf('=');
      if (eqIndex === -1) continue;
      const name = nameValue.substring(0, eqIndex).trim();
      const value = nameValue.substring(eqIndex + 1).trim();
      this.authState.cookies.set(name, value);

      if (name === 'BPMSESSIONID') this.authState.sessionId = value;
      if (name === 'BPMCSRF') this.authState.csrfToken = value;
    }
  }

  private buildCookieString(): string {
    const parts: string[] = [];
    for (const [name, value] of this.authState.cookies) {
      parts.push(`${name}=${value}`);
    }
    return parts.join('; ');
  }

  private assertAllowedOrigin(url: string): void {
    if (!this.allowedOrigin) return;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new BpmApiError(`Некорректный URL запроса: ${url}`, 0);
    }
    if (parsed.origin !== this.allowedOrigin) {
      throw new BpmApiError(
        `URL ${parsed.origin} не соответствует разрешённому origin ${this.allowedOrigin}. Возможна попытка SSRF/перенаправления на сторонний хост.`,
        0
      );
    }
  }

  private parseRetryAfter(header: string | undefined): number | null {
    if (!header) return null;
    const seconds = parseInt(header, 10);
    if (!isNaN(seconds) && seconds >= 0) {
      return Math.min(seconds, MAX_RETRY_AFTER_SECONDS) * 1000;
    }
    // HTTP-date form
    const date = Date.parse(header);
    if (!isNaN(date)) {
      const ms = Math.max(0, date - Date.now());
      return Math.min(ms, MAX_RETRY_AFTER_SECONDS * 1000);
    }
    return null;
  }

  private logRequest(options: HttpRequestOptions, headers: Record<string, string>): void {
    if (this.debugMode === 'off') return;
    const masked = maskSecrets(headers);
    console.error(`[HttpClient][req] ${options.method} ${options.url}`);
    if (this.debugMode === 'trace') {
      console.error(`[HttpClient][req] headers=${JSON.stringify(masked)}`);
      if (options.body !== undefined && options.body !== null && options.method !== 'GET') {
        console.error(`[HttpClient][req] body=${maskBody(options.body)}`);
      }
    }
  }

  private logResponse<T>(options: HttpRequestOptions, response: HttpResponse<T>, durationMs: number): void {
    if (this.debugMode === 'off') return;
    console.error(
      `[HttpClient][res] ${options.method} ${shortUrl(options.url)} -> ${response.status} (${durationMs}ms)`
    );
    if (this.debugMode === 'trace' && response.data !== undefined) {
      console.error(`[HttpClient][res] body=${truncate(safeStringify(response.data), 1000)}`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}${u.search ? '?' + u.search.slice(1, 80) : ''}`;
  } catch {
    return url;
  }
}

function safeStringify(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'string') return value.length > 1024 ? value.slice(0, 1024) + '…' : value;
  if (Buffer.isBuffer?.(value as Buffer) || value instanceof Uint8Array) {
    return `<binary ${(value as Uint8Array).byteLength} bytes>`;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

const SECRET_HEADERS = new Set(['cookie', 'set-cookie', 'authorization', 'bpmcsrf']);
const SECRET_BODY_KEYS = ['userpassword', 'password', 'token', 'secret', 'apikey', 'api_key'];

function maskSecrets(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (SECRET_HEADERS.has(k.toLowerCase())) {
      out[k] = '<masked>';
    } else {
      out[k] = v;
    }
  }
  return out;
}

function maskBody(body: unknown): string {
  if (body === undefined || body === null) return String(body);
  if (typeof body === 'string') return truncate(body, 500);
  if (Buffer.isBuffer?.(body as Buffer) || body instanceof Uint8Array) {
    return `<binary ${(body as Uint8Array).byteLength} bytes>`;
  }
  if (typeof body === 'object') {
    try {
      const cloned = JSON.parse(JSON.stringify(body));
      maskObjectInPlace(cloned);
      return truncate(JSON.stringify(cloned), 500);
    } catch {
      return '<unserializable>';
    }
  }
  return String(body);
}

function maskObjectInPlace(obj: Record<string, unknown>): void {
  if (!obj || typeof obj !== 'object') return;
  for (const k of Object.keys(obj)) {
    if (SECRET_BODY_KEYS.includes(k.toLowerCase())) {
      obj[k] = '<masked>';
    } else if (obj[k] && typeof obj[k] === 'object') {
      maskObjectInPlace(obj[k] as Record<string, unknown>);
    }
  }
}
