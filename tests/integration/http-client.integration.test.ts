import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { HttpClient } from '../../src/client/http-client.js';
import { BpmApiError } from '../../src/utils/errors.js';
import type { BpmConfig } from '../../src/types/index.js';

const ORIGIN = 'https://bpm.test';

function makeCfg(overrides: Partial<BpmConfig> = {}): BpmConfig {
  return {
    bpmsoft_url: ORIGIN,
    username: 'u',
    password: 'p',
    odata_version: 4,
    platform: 'net8',
    page_size: 100,
    max_batch_size: 100,
    lookup_cache_ttl: 300,
    request_timeout: 5000,
    max_file_size: 10 * 1024 * 1024,
    ...overrides,
  };
}

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());
afterEach(() => server.resetHandlers());

describe('HttpClient (integration with MSW)', () => {
  it('GET succeeds and sends BPMCSRF + ForceUseSession when token present', async () => {
    let captured: Headers | null = null;
    server.use(
      http.get(`${ORIGIN}/odata/Contact`, ({ request }) => {
        captured = request.headers;
        return HttpResponse.json({ value: [] });
      })
    );

    const client = new HttpClient(makeCfg());
    client.setAllowedOrigin(ORIGIN);
    client.updateAuthState({ csrfToken: 'csrf-abc', isAuthenticated: true });

    const res = await client.request<{ value: unknown[] }>({
      method: 'GET',
      url: `${ORIGIN}/odata/Contact`,
    });

    expect(res.status).toBe(200);
    expect(res.data).toEqual({ value: [] });
    expect(captured).not.toBeNull();
    expect(captured!.get('bpmcsrf')).toBe('csrf-abc');
    expect(captured!.get('forceusesession')).toBe('true');
  });

  it('Binary PUT sends raw bytes (server reads them via arrayBuffer)', async () => {
    const payload = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02]);
    let receivedLength = -1;
    let receivedFirst = -1;
    // MSW v2 uses path-to-regexp; raw parens have meaning. Match by regex to be safe.
    server.use(
      http.put(/\/odata\/Contact\(1\)\/Photo$/, async ({ request }) => {
        const ab = await request.arrayBuffer();
        const bytes = new Uint8Array(ab);
        receivedLength = bytes.byteLength;
        receivedFirst = bytes[0];
        return new HttpResponse(null, { status: 204 });
      })
    );

    const client = new HttpClient(makeCfg());
    client.setAllowedOrigin(ORIGIN);

    const res = await client.request({
      method: 'PUT',
      url: `${ORIGIN}/odata/Contact(1)/Photo`,
      body: payload,
      contentKind: 'binary',
    });

    expect(res.status).toBe(204);
    expect(receivedLength).toBe(payload.length);
    expect(receivedFirst).toBe(0xde);
  });

  it('Binary GET (responseType=binary) returns a Buffer with same bytes', async () => {
    const expected = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    server.use(
      http.get(/\/odata\/Contact\(1\)\/Photo$/, () => {
        return new HttpResponse(expected, {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream' },
        });
      })
    );

    const client = new HttpClient(makeCfg());
    client.setAllowedOrigin(ORIGIN);

    const res = await client.request<Buffer>({
      method: 'GET',
      url: `${ORIGIN}/odata/Contact(1)/Photo`,
      contentKind: 'binary',
      responseType: 'binary',
    });

    expect(Buffer.isBuffer(res.data)).toBe(true);
    expect(Buffer.compare(res.data, expected)).toBe(0);
  });

  it('401 triggers reauth handler exactly once, then retries', async () => {
    let count = 0;
    server.use(
      http.get(`${ORIGIN}/odata/Contact`, () => {
        count += 1;
        if (count === 1) {
          return new HttpResponse(null, { status: 401 });
        }
        return HttpResponse.json({ value: [{ Id: 'ok' }] });
      })
    );

    const client = new HttpClient(makeCfg());
    client.setAllowedOrigin(ORIGIN);

    const reauth = vi.fn(async () => {
      client.updateAuthState({ csrfToken: 'new-token', isAuthenticated: true });
    });
    client.setReauthHandler(reauth);

    const res = await client.request<{ value: unknown[] }>({
      method: 'GET',
      url: `${ORIGIN}/odata/Contact`,
    });

    expect(reauth).toHaveBeenCalledTimes(1);
    expect(count).toBe(2);
    expect(res.status).toBe(200);
  });

  it('5xx with Retry-After:0 is retried (503 -> 200)', async () => {
    let count = 0;
    server.use(
      http.get(`${ORIGIN}/odata/Contact`, () => {
        count += 1;
        if (count === 1) {
          return new HttpResponse(null, {
            status: 503,
            headers: { 'Retry-After': '0' },
          });
        }
        return HttpResponse.json({ value: [] });
      })
    );

    const client = new HttpClient(makeCfg());
    client.setAllowedOrigin(ORIGIN);

    const res = await client.request<{ value: unknown[] }>({
      method: 'GET',
      url: `${ORIGIN}/odata/Contact`,
    });

    expect(count).toBe(2);
    expect(res.status).toBe(200);
  });

  it('SSRF guard: cross-origin requests throw BpmApiError without hitting network', async () => {
    let evilCalled = false;
    server.use(
      http.get('https://evil.example/x', () => {
        evilCalled = true;
        return HttpResponse.json({});
      })
    );

    const client = new HttpClient(makeCfg());
    client.setAllowedOrigin(ORIGIN);

    await expect(
      client.request({ method: 'GET', url: 'https://evil.example/x' })
    ).rejects.toBeInstanceOf(BpmApiError);

    expect(evilCalled).toBe(false);
  });
});
