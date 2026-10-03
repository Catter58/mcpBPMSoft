import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../../src/client/http-client.js';
import { runWithAuth, type RequestAuth } from '../../src/auth/request-context.js';
import { runWithReadBudget, runWithRequestSignal } from '../../src/server/request-runtime.js';
import type { BpmConfig } from '../../src/types/index.js';

const base: BpmConfig = {
  bpmsoft_url: 'https://bpm.test',
  odata_version: 4,
  platform: 'net8',
  page_size: 100,
  max_batch_size: 100,
  lookup_cache_ttl: 300,
  request_timeout: 5000,
  max_file_size: 4,
};
const auth: RequestAuth = { csrfToken: 'csrf', cookies: new Map([['BPMSESSIONID', 'session']]) };
const limits = { timeoutMs: 1000, maxRequests: 10, maxBytes: 1000 };
const read = (client: HttpClient, url = 'https://bpm.test/odata/Contact') =>
  runWithAuth(auth, () => client.request({ method: 'GET', url }));

afterEach(() => vi.unstubAllGlobals());

describe('HTTP read budgets and bounded bodies', () => {
  it('counts redirects as actual network attempts and blocks the destination before dispatch', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'https://bpm.test/odata/New' },
      })
    );
    vi.stubGlobal('fetch', fetch);
    await expect(
      runWithReadBudget({ ...limits, maxRequests: 1 }, () => read(new HttpClient(base)))
    ).rejects.toMatchObject({ code: 'budget_exceeded' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('counts retries and never retries an exhausted budget', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response('{}', {
        status: 503,
        headers: { 'retry-after': '0', 'content-type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetch);
    await expect(
      runWithReadBudget({ ...limits, maxRequests: 1 }, () => read(new HttpClient(base)))
    ).rejects.toMatchObject({ code: 'budget_exceeded' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('shares a byte budget across concurrent responses while isolating different tool calls', async () => {
    const fetch = vi.fn().mockImplementation(
      async () =>
        new Response('{"a":1}', {
          headers: { 'content-type': 'application/json' },
        })
    );
    vi.stubGlobal('fetch', fetch);
    const client = new HttpClient(base);
    await expect(
      runWithReadBudget({ ...limits, maxBytes: 10 }, () => Promise.all([read(client), read(client)]))
    ).rejects.toMatchObject({ code: 'budget_exceeded' });
    await expect(
      Promise.all([
        runWithReadBudget({ ...limits, maxBytes: 7, maxRequests: 1 }, () => read(client)),
        runWithReadBudget({ ...limits, maxBytes: 7, maxRequests: 1 }, () => read(client)),
      ])
    ).resolves.toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('rejects declared oversize bodies without pulling their data', async () => {
    const cancel = vi.fn();
    const pull = vi.fn();
    const stream = new ReadableStream({ pull, cancel }, { highWaterMark: 0 });
    const fetch = vi.fn().mockResolvedValue(
      new Response(stream, {
        headers: { 'content-type': 'application/json', 'content-length': String(17 * 1024 * 1024) },
      })
    );
    vi.stubGlobal('fetch', fetch);
    await expect(read(new HttpClient(base))).rejects.toMatchObject({ code: 'budget_exceeded' });
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('caps chunked binary data without a Content-Length header', async () => {
    const cancel = vi.fn();
    let chunks = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          chunks++;
          controller.enqueue(new Uint8Array(3));
        },
        cancel,
      },
      { highWaterMark: 0 }
    );
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(stream, {
          headers: { 'content-type': 'application/octet-stream' },
        })
      )
    );
    await expect(read(new HttpClient(base))).rejects.toMatchObject({ code: 'budget_exceeded' });
    expect(chunks).toBe(2);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('aborts a stalled response body with the tool timeout', async () => {
    const cancel = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(new ReadableStream({ cancel }), {
          headers: { 'content-type': 'application/json' },
        })
      )
    );
    await expect(
      runWithReadBudget({ ...limits, timeoutMs: 20 }, () => read(new HttpClient(base)))
    ).rejects.toMatchObject({ code: 'budget_exceeded' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('a mutation with an oversized response has unknown outcome and is never replayed', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response('oversized', {
        status: 201,
        headers: { 'content-type': 'application/octet-stream' },
      })
    );
    vi.stubGlobal('fetch', fetch);
    await expect(
      runWithAuth(auth, () =>
        new HttpClient(base).request({
          method: 'POST',
          url: 'https://bpm.test/odata/Contact',
          body: { Name: 'a' },
        })
      )
    ).rejects.toMatchObject({ code: 'outcome_unknown' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('disconnecting after mutation dispatch yields unknown outcome without another attempt', async () => {
    const controller = new AbortController();
    const fetch = vi.fn().mockImplementation(async () => {
      controller.abort();
      return new Response(new ReadableStream(), { status: 201 });
    });
    vi.stubGlobal('fetch', fetch);
    await expect(
      runWithRequestSignal(controller.signal, () =>
        runWithAuth(auth, () =>
          new HttpClient(base).request({ method: 'POST', url: 'https://bpm.test/odata/Contact', body: {} })
        )
      )
    ).rejects.toMatchObject({ code: 'outcome_unknown' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('tenant upstream boundaries', () => {
  const tenantConfig = { ...base, tenant_id: 'a', bpmsoft_url: 'https://bpm.test/stand-a' };
  it('rejects a tenant/credential mismatch before dispatch', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(
      runWithAuth({ ...auth, tenantId: 'b' }, () =>
        new HttpClient(tenantConfig).request({ method: 'GET', url: 'https://bpm.test/stand-a/odata/Contact' })
      )
    ).rejects.toMatchObject({ httpStatus: 403 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    'https://bpm.test/stand-b/odata/Contact',
    'https://bpm.test/stand-a-other/odata/Contact',
    'https://bpm.test/stand-a/%2f..%2fstand-b/odata/Contact',
    'https://bpm.test/stand-a/%252e%252e/stand-b/odata/Contact',
    'https://other.test/stand-a/odata/Contact',
  ])('rejects a path outside the configured stand: %s', async (url) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(
      runWithAuth({ ...auth, tenantId: 'a' }, () =>
        new HttpClient(tenantConfig).request({ method: 'GET', url })
      )
    ).rejects.toBeInstanceOf(Error);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a same-origin redirect into another stand', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: '/stand-b/odata/Contact' },
      })
    );
    vi.stubGlobal('fetch', fetch);
    await expect(
      runWithAuth({ ...auth, tenantId: 'a' }, () =>
        new HttpClient(tenantConfig).request({ method: 'GET', url: 'https://bpm.test/stand-a/odata/Contact' })
      )
    ).rejects.toMatchObject({ httpStatus: 403 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
