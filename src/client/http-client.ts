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
 * - Retry read operations with exponential backoff for 5xx
 * - Retry honoring Retry-After for 429/503
 * - Auto-reauthentication on 401/403 (single attempt)
 * - Optional debug logging via BPMSOFT_DEBUG=1|trace with secret masking
 */

import type { BpmConfig, HttpRequestOptions, HttpResponse, AuthState } from '../types/index.js';
import { BpmApiError, parseODataError, AuthRequiredError } from '../utils/errors.js';
import { getRequestAuth, hasRequestAuth } from '../auth/request-context.js';

const MAX_RETRIES = 3;
const MAX_REDIRECTS = 5;
const RETRY_BASE_DELAY_MS = 1000;
const MAX_RETRY_AFTER_SECONDS = 60; // hard cap to avoid pathological waits

/** Auth resolved for a single request: a BPMCSRF token and the cookies to send. */
type ResolvedAuth = { csrfToken: string | null; cookies: Map<string, string> };

export class HttpClient {
  private authState: AuthState = {
    sessionId: null,
    csrfToken: null,
    cookies: new Map(),
    isAuthenticated: false,
  };

  private reauthHandler: (() => Promise<void>) | null = null;
  private reauthPromise: Promise<void> | null = null;
  private allowedOrigin: string | null = null;
  private allowEnvCreds = false;

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

  /** Enable the hidden env-stored credentials path (off by default). */
  setAllowEnvCreds(allow: boolean): void {
    this.allowEnvCreds = allow;
  }

  /**
   * Resolve auth for an authenticated request.
   * Priority: per-request ALS auth > env-creds singleton (opt-in) > error.
   * Returns null only for skipAuth requests (login/CSRF fetch).
   */
  private resolveAuth(skipAuth?: boolean): ResolvedAuth | null {
    if (skipAuth) {
      // Login / CSRF-fetch flow: use whatever the singleton accumulated (creds path).
      return { csrfToken: null, cookies: this.authState.cookies };
    }
    const reqAuth = getRequestAuth();
    if (hasRequestAuth(reqAuth)) {
      return { csrfToken: reqAuth.csrfToken ?? null, cookies: reqAuth.cookies };
    }
    if (this.allowEnvCreds) {
      return { csrfToken: this.authState.csrfToken, cookies: this.authState.cookies };
    }
    throw new AuthRequiredError();
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
    return { ...this.authState, cookies: new Map(this.authState.cookies) };
  }

  /**
   * Perform an HTTP request with all BPMSoft-specific handling
   */
  async request<T = unknown>(options: HttpRequestOptions): Promise<HttpResponse<T>> {
    this.assertAllowedOrigin(options.url);
    const timeout = options.timeout ?? this.config.request_timeout;
    const timeoutSignal = AbortSignal.timeout(timeout);
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
    return this.requestWithRetry<T>({ ...options, signal }, 0, false);
  }

  private async requestWithRetry<T>(
    options: HttpRequestOptions,
    attempt: number,
    reauthenticated: boolean
  ): Promise<HttpResponse<T>> {
    const mutation =
      options.operation === 'mutation' || (options.operation !== 'read' && options.method !== 'GET');
    const resolved = this.resolveAuth(options.skipAuth);
    const headers = this.buildHeaders(options, resolved);
    const cookieStr = this.buildCookieString(resolved);
    if (cookieStr) headers['Cookie'] = cookieStr;
    const startedAt = Date.now();
    let dispatched = false;
    try {
      options.signal?.throwIfAborted();
      const fetchOptions: RequestInit = {
        method: options.method,
        headers,
        signal: options.signal,
        redirect: 'manual',
      };
      if (options.body !== undefined && options.body !== null && options.method !== 'GET') {
        fetchOptions.body = this.encodeBody(options.body, headers);
      }
      this.logRequest(options, headers);
      let currentUrl = options.url;
      dispatched = true;
      let response = await fetch(currentUrl, fetchOptions);
      let redirects = 0;
      while ([301, 302, 303, 307, 308].includes(response.status) && response.headers.get('location')) {
        // Reissuing a side effect at a redirect destination has no exactly-once guarantee.
        if (mutation) throw outcomeUnknown(response.status, 'Сервер перенаправил запрос изменения.');
        if (++redirects > MAX_REDIRECTS) throw new BpmApiError('Превышено число редиректов', 0);
        const nextUrl = new URL(response.headers.get('location') as string, currentUrl).toString();
        this.assertAllowedOrigin(nextUrl);
        currentUrl = nextUrl;
        response = await fetch(currentUrl, fetchOptions);
      }
      this.extractCookies(response);
      let data: T;
      try {
        data = await this.decodeBody<T>(response, options);
      } catch (error) {
        if (response.ok) throw error;
        // The HTTP status still establishes a definite rejection even if the
        // platform's error envelope is malformed or empty.
        data = undefined as T;
      }
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

      // A definite auth rejection precedes execution; one re-login is safe.
      if (
        (response.status === 401 || response.status === 403) &&
        !options.skipAuth &&
        !hasRequestAuth(getRequestAuth())
      ) {
        if (!reauthenticated && this.allowEnvCreds && this.reauthHandler) {
          dispatched = false; // The rejected attempt could not execute the mutation.
          options.signal?.throwIfAborted();
          await abortable(this.reauthenticate(), options.signal);
          return this.requestWithRetry<T>(options, attempt, true);
        }
      }
      if (mutation && (response.status >= 500 || response.status === 408)) {
        throw outcomeUnknown(response.status, parseODataError(data) ?? truncate(safeStringify(data), 1000));
      }
      if (
        !mutation &&
        ([500, 502, 503, 504].includes(response.status) || response.status === 429) &&
        !isDeterministicAppError(data) &&
        attempt < MAX_RETRIES
      ) {
        const delayMs =
          this.parseRetryAfter(responseHeaders['retry-after']) ?? RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        console.error(
          `[HttpClient] HTTP ${response.status}; retry ${attempt + 1}/${MAX_RETRIES} in ${delayMs}ms`
        );
        await sleep(delayMs, options.signal);
        return this.requestWithRetry<T>(options, attempt + 1, reauthenticated);
      }
      if (!response.ok && response.status !== 304) {
        const message = parseODataError(data);
        const bodySnippet = truncate(safeStringify(data), 1000);
        throw new BpmApiError(
          message || `HTTP ${response.status}: ${response.statusText}`,
          response.status,
          undefined,
          message ?? (bodySnippet && bodySnippet !== '{}' ? `Тело ответа: ${bodySnippet}` : undefined)
        );
      }
      return httpResponse;
    } catch (error) {
      if (error instanceof BpmApiError) throw error;
      const interrupted =
        options.signal?.aborted ||
        (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name));
      if (mutation && dispatched) {
        throw outcomeUnknown(
          interrupted ? 408 : 0,
          interrupted
            ? 'Запрос прерван или истёк таймаут.'
            : 'Соединение прервано до получения корректного ответа.'
        );
      }
      throw new BpmApiError(
        interrupted
          ? 'Запрос прерван или истёк таймаут.'
          : `Сетевая ошибка: ${error instanceof Error ? error.message : String(error)}`,
        interrupted ? 408 : 0,
        undefined,
        undefined,
        undefined,
        undefined,
        'network'
      );
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
  private buildHeaders(options: HttpRequestOptions, resolved: ResolvedAuth | null): Record<string, string> {
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
        contentType = v3 ? 'application/json; odata=verbose' : 'application/json; IEEE754Compatible=true';
        accept = v3 ? 'application/json; odata=verbose' : 'application/json; IEEE754Compatible=true';
        break;
    }

    const headers: Record<string, string> = {
      'Content-Type': contentType,
      Accept: accept,
      ...options.headers,
    };

    if (!options.skipAuth && resolved) {
      if (resolved.csrfToken) {
        headers['BPMCSRF'] = resolved.csrfToken;
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
    const responseType = options.responseType ?? 'auto';
    if (response.status === 204) {
      if (responseType === 'binary') return Buffer.alloc(0) as unknown as T;
      if (responseType === 'text') return '' as unknown as T;
      return {} as T;
    }

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
    if (
      contentType.includes('application/octet-stream') ||
      contentType.includes('image/') ||
      contentType.includes('application/pdf')
    ) {
      const buf = await response.arrayBuffer();
      return Buffer.from(buf) as unknown as T;
    }
    return (await response.text()) as unknown as T;
  }

  private async reauthenticate(): Promise<void> {
    if (!this.reauthPromise) {
      this.reauthPromise = (async () => {
        try {
          await this.reauthHandler?.();
        } finally {
          this.reauthPromise = null;
        }
      })();
    }
    return this.reauthPromise;
  }

  private extractCookies(response: Response): void {
    // In per-request mode, do not persist Set-Cookie into the shared singleton
    // (anti cross-user leakage). Only the env-creds login flow accumulates cookies.
    if (hasRequestAuth(getRequestAuth())) return;
    // Node 18+ provides getSetCookie(); fall back to single header otherwise.
    const setCookies =
      typeof (response.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === 'function'
        ? (response.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
        : response.headers.get('set-cookie')
          ? [response.headers.get('set-cookie') as string]
          : [];

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

  private buildCookieString(resolved: ResolvedAuth | null): string {
    const cookies = resolved?.cookies ?? this.authState.cookies;
    const parts: string[] = [];
    for (const [name, value] of cookies) {
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
    const seconds = /^\d+$/.test(header.trim()) ? Number(header.trim()) : NaN;
    if (Number.isFinite(seconds) && seconds >= 0) {
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
    console.error(`[HttpClient][req] ${options.method} ${shortUrl(options.url)}`);
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

function outcomeUnknown(status: number, details?: string): BpmApiError {
  return new BpmApiError(
    'Результат операции неизвестен: сервер мог уже выполнить изменение.',
    status,
    undefined,
    [details, 'Запрос мог выполниться на сервере; проверьте фактическое состояние до повтора.']
      .filter(Boolean)
      .join('\n'),
    undefined,
    [
      'Не повторяйте запрос вслепую: сервер мог уже выполнить изменение.',
      'Проверьте существование и состояние записи через bpm_get_record, bpm_get_records или bpm_count_records по известному UUID или уникальным полям.',
      'Для создания используйте тот же idempotency_key; новый ключ может создать дубль.',
    ],
    'outcome_unknown'
  );
}

const TRANSIENT_ERROR_RE =
  /timeout|timed out|deadlock|could not serialize|too many clients|connection|transport|temporar|reading from stream|end of stream|broken pipe/i;

/** Read retries do not repeat deterministic application errors. */
function isDeterministicAppError(body: unknown): boolean {
  let parsed = body;
  if (body instanceof Uint8Array) parsed = Buffer.from(body).toString('utf8');
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return false;
    }
  }
  const message = parseODataError(parsed);
  if (!message) return false;
  const envelope = parsed as {
    error?: { innererror?: { type?: unknown; message?: unknown } };
    'odata.error'?: { innererror?: { type?: unknown; message?: unknown } };
  };
  const inner = (envelope.error ?? envelope['odata.error'])?.innererror;
  return !TRANSIENT_ERROR_RE.test([message, inner?.type, inner?.message].join(' '));
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      }
    );
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const done = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
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
