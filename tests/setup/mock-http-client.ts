/**
 * Tiny stub of HttpClient used by ODataClient/LookupResolver tests.
 *
 * It implements only the public surface needed by those classes:
 *   - request<T>(opts)
 *   - setAllowedOrigin(origin)
 *
 * The real HttpClient does much more (retries, cookies, reauth) but
 * those concerns belong to the integration tests that exercise it
 * end-to-end via MSW.
 */

import type { HttpRequestOptions, HttpResponse } from '../../src/types/index.js';

export type RecordedRequest = HttpRequestOptions;

export type ResponseHandler = (
  opts: HttpRequestOptions,
  index: number
) => Partial<HttpResponse<unknown>> | Promise<Partial<HttpResponse<unknown>>>;

export class MockHttpClient {
  public requests: RecordedRequest[] = [];
  public allowedOrigin: string | null = null;
  private handlers: ResponseHandler[] = [];
  private fallback: ResponseHandler | null = null;
  private callCount = 0;

  setAllowedOrigin(origin: string): void {
    this.allowedOrigin = origin;
  }

  setReauthHandler(_handler: () => Promise<void>): void {
    /* no-op for tests */
  }

  /** Replace the entire response queue. */
  setResponses(handlers: ResponseHandler[]): void {
    this.handlers = [...handlers];
  }

  /** Set a fallback handler used after the queue is drained. */
  setFallback(handler: ResponseHandler): void {
    this.fallback = handler;
  }

  async request<T = unknown>(options: HttpRequestOptions): Promise<HttpResponse<T>> {
    this.requests.push(options);
    const handler = this.handlers.shift() ?? this.fallback;
    if (!handler) {
      throw new Error(
        `MockHttpClient: no response queued for ${options.method} ${options.url}`
      );
    }
    const partial = await handler(options, this.callCount++);
    return {
      status: partial.status ?? 200,
      statusText: partial.statusText ?? 'OK',
      headers: partial.headers ?? {},
      data: (partial.data ?? {}) as T,
      ok: partial.ok ?? ((partial.status ?? 200) >= 200 && (partial.status ?? 200) < 300),
    };
  }
}
