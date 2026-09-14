import { describe, it, expect, beforeAll, afterAll, afterEach, vi, onTestFinished } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { HttpClient } from '../../src/client/http-client.js';
import { BpmApiError } from '../../src/utils/errors.js';
import { runWithAuth, extractAuthFromHeaders } from '../../src/auth/request-context.js';
import { AuthRequiredError } from '../../src/utils/errors.js';
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
    client.setAllowEnvCreds(true);
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

    const res = await runWithAuth(extractAuthFromHeaders({ BPMCSRF: 't', Cookie: 'CsrfToken=t' }), () =>
      client.request({
        method: 'PUT',
        url: `${ORIGIN}/odata/Contact(1)/Photo`,
        body: payload,
        contentKind: 'binary',
      })
    );

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

    const res = await runWithAuth(extractAuthFromHeaders({ BPMCSRF: 't', Cookie: 'CsrfToken=t' }), () =>
      client.request<Buffer>({
        method: 'GET',
        url: `${ORIGIN}/odata/Contact(1)/Photo`,
        contentKind: 'binary',
        responseType: 'binary',
      })
    );

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
    client.setAllowEnvCreds(true);

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

    const res = await runWithAuth(extractAuthFromHeaders({ BPMCSRF: 't', Cookie: 'CsrfToken=t' }), () =>
      client.request<{ value: unknown[] }>({
        method: 'GET',
        url: `${ORIGIN}/odata/Contact`,
      })
    );

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
      runWithAuth(extractAuthFromHeaders({ BPMCSRF: 't', Cookie: 'CsrfToken=t' }), () =>
        client.request({ method: 'GET', url: 'https://evil.example/x' })
      )
    ).rejects.toBeInstanceOf(BpmApiError);

    expect(evilCalled).toBe(false);
  });
});

describe('HttpClient auth resolution', () => {
  it('per-request: sends caller BPMCSRF + forwarded cookies from ALS', async () => {
    let captured: Headers | null = null;
    server.use(
      http.get(`${ORIGIN}/odata/Contact`, ({ request }) => {
        captured = request.headers;
        return HttpResponse.json({ value: [] });
      })
    );

    const client = new HttpClient(makeCfg());
    client.setAllowedOrigin(ORIGIN);

    const auth = extractAuthFromHeaders({
      BPMCSRF: 'req-csrf',
      Cookie: '.ASPXAUTH=aaa; BPMSESSIONID=sss; CsrfToken=ttt',
    });

    const res = await runWithAuth(auth, () =>
      client.request<{ value: unknown[] }>({ method: 'GET', url: `${ORIGIN}/odata/Contact` })
    );

    expect(res.status).toBe(200);
    expect(captured!.get('bpmcsrf')).toBe('req-csrf');
    expect(captured!.get('forceusesession')).toBe('true');
    const cookie = captured!.get('cookie') || '';
    expect(cookie).toContain('.ASPXAUTH=aaa');
    expect(cookie).toContain('BPMSESSIONID=sss');
    expect(cookie).toContain('CsrfToken=ttt');
  });

  it('no auth + env-creds off -> AuthRequiredError before network', async () => {
    let called = false;
    server.use(
      http.get(`${ORIGIN}/odata/Contact`, () => {
        called = true;
        return HttpResponse.json({ value: [] });
      })
    );

    const client = new HttpClient(makeCfg());
    client.setAllowedOrigin(ORIGIN);

    await expect(client.request({ method: 'GET', url: `${ORIGIN}/odata/Contact` })).rejects.toBeInstanceOf(
      AuthRequiredError
    );
    expect(called).toBe(false);
  });
});

describe('HttpClient redirect SSRF guard', () => {
  it('refuses to follow a cross-origin redirect (no creds leak to other host)', async () => {
    let evilHit = false;
    server.use(
      http.get(
        `${ORIGIN}/odata/Contact`,
        () => new HttpResponse(null, { status: 302, headers: { Location: 'https://evil.example/steal' } })
      ),
      http.get('https://evil.example/steal', () => {
        evilHit = true;
        return HttpResponse.json({ pwned: true });
      })
    );
    const client = new HttpClient(makeCfg());
    client.setAllowedOrigin(ORIGIN);
    await expect(
      runWithAuth(extractAuthFromHeaders({ BPMCSRF: 't', Cookie: 'CsrfToken=t' }), () =>
        client.request({ method: 'GET', url: `${ORIGIN}/odata/Contact` })
      )
    ).rejects.toBeInstanceOf(BpmApiError);
    expect(evilHit).toBe(false);
  });

  it('follows a same-origin redirect', async () => {
    server.use(
      http.get(
        `${ORIGIN}/odata/Old`,
        () => new HttpResponse(null, { status: 302, headers: { Location: `${ORIGIN}/odata/New` } })
      ),
      http.get(`${ORIGIN}/odata/New`, () => HttpResponse.json({ value: [{ Id: 'x' }] }))
    );
    const client = new HttpClient(makeCfg());
    client.setAllowedOrigin(ORIGIN);
    const res = await runWithAuth(extractAuthFromHeaders({ BPMCSRF: 't', Cookie: 'CsrfToken=t' }), () =>
      client.request<{ value: unknown[] }>({ method: 'GET', url: `${ORIGIN}/odata/Old` })
    );
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ value: [{ Id: 'x' }] });
  });
});

describe('HttpClient 5xx replay safety', () => {
  const auth = () => extractAuthFromHeaders({ BPMCSRF: 't', Cookie: 'CsrfToken=t' });

  it('POST is NOT replayed on 500 (BPMSoft may have persisted the record)', async () => {
    let count = 0;
    server.use(
      http.post(`${ORIGIN}/odata/Activity`, () => {
        count += 1;
        return HttpResponse.json({ error: { message: 'boom' } }, { status: 500 });
      })
    );

    const client = new HttpClient(makeCfg());
    client.setAllowedOrigin(ORIGIN);

    await expect(
      runWithAuth(auth(), () =>
        client.request({ method: 'POST', url: `${ORIGIN}/odata/Activity`, body: { Title: 'x' } })
      )
    ).rejects.toMatchObject({ httpStatus: 500, message: 'boom' });

    expect(count).toBe(1);
  });

  it('GET is still retried on a transient 500 and the server message reaches the caller', async () => {
    let count = 0;
    server.use(
      http.get(`${ORIGIN}/odata/Contact`, () => {
        count += 1;
        return HttpResponse.json(
          {
            error: {
              message: { lang: 'ru', value: 'сломалось' },
              innererror: { type: 'Npgsql.NpgsqlException', message: 'Exception while reading from stream' },
            },
          },
          { status: 500 }
        );
      })
    );

    const client = new HttpClient(makeCfg());
    client.setAllowedOrigin(ORIGIN);

    await expect(
      runWithAuth(auth(), () => client.request({ method: 'GET', url: `${ORIGIN}/odata/Contact` }))
    ).rejects.toMatchObject({ httpStatus: 500, message: 'сломалось' });

    expect(count).toBe(1 + 3); // initial + MAX_RETRIES
  }, 20000);

  it('PATCH with a deterministic OData business error (500) is NOT retried', async () => {
    let count = 0;
    server.use(
      http.patch(/\/odata\/SysAdminUnit\(1\)$/, () => {
        count += 1;
        return HttpResponse.json(
          {
            error: {
              code: null,
              message: 'Невозможно добавить корневую единицу администрирования',
              innererror: {
                message: 'Невозможно добавить корневую единицу администрирования',
                type: 'BPMSoft.Web.OData.Exceptions.GenericODataException',
              },
            },
          },
          { status: 500 }
        );
      })
    );
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const client = new HttpClient(makeCfg());
    client.setAllowedOrigin(ORIGIN);

    await expect(
      runWithAuth(auth(), () =>
        client.request({ method: 'PATCH', url: `${ORIGIN}/odata/SysAdminUnit(1)`, body: { Name: 'x' } })
      )
    ).rejects.toMatchObject({
      httpStatus: 500,
      message: 'Невозможно добавить корневую единицу администрирования',
    });

    expect(count).toBe(1);
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes('прикладная ошибка сервера'))).toBe(true);
    errSpy.mockRestore();
  });

  it('binary GET 500 with a JSON error body is decoded and NOT retried', async () => {
    let count = 0;
    server.use(
      http.get(/\/odata\/SysImage\(1\)\/Data$/, () => {
        count += 1;
        const body = JSON.stringify({
          error: {
            message: 'Input string was not in a correct format.',
            innererror: { type: 'System.FormatException' },
          },
        });
        return new HttpResponse(Buffer.from(body), {
          status: 500,
          headers: { 'Content-Type': 'application/octet-stream' },
        });
      })
    );

    const client = new HttpClient(makeCfg());
    client.setAllowedOrigin(ORIGIN);

    await expect(
      runWithAuth(auth(), () =>
        client.request({
          method: 'GET',
          url: `${ORIGIN}/odata/SysImage(1)/Data`,
          contentKind: 'binary',
          responseType: 'binary',
        })
      )
    ).rejects.toMatchObject({ httpStatus: 500, message: 'Input string was not in a correct format.' });
    expect(count).toBe(1);
  });

  it('POST 500 warns in details and next_steps that the record may exist', async () => {
    server.use(
      http.post(`${ORIGIN}/odata/Activity`, () =>
        HttpResponse.json({ error: { message: 'boom' } }, { status: 500 })
      )
    );
    const client = new HttpClient(makeCfg());
    client.setAllowedOrigin(ORIGIN);

    const err = (await runWithAuth(auth(), () =>
      client.request({ method: 'POST', url: `${ORIGIN}/odata/Activity`, body: { Title: 'x' } })
    ).catch((e: unknown) => e)) as BpmApiError;

    expect(err).toBeInstanceOf(BpmApiError);
    expect(err.details).toContain('boom');
    expect(err.details).toContain('мог выполниться на сервере');
    expect(err.toToolError().next_steps?.join(' ')).toContain('bpm_get_records');
  });

  it('POST timeout keeps 408 and tells the agent not to retry blindly', async () => {
    let count = 0;
    server.use(
      http.post(`${ORIGIN}/odata/Activity`, async () => {
        count += 1;
        await new Promise((r) => setTimeout(r, 300));
        return HttpResponse.json({ Id: '1' }, { status: 201 });
      })
    );
    const client = new HttpClient(makeCfg({ request_timeout: 50 }));
    client.setAllowedOrigin(ORIGIN);

    const err = (await runWithAuth(auth(), () =>
      client.request({ method: 'POST', url: `${ORIGIN}/odata/Activity`, body: { Title: 'x' } })
    ).catch((e: unknown) => e)) as BpmApiError;

    expect(err.httpStatus).toBe(408);
    expect(err.message).toMatch(
      /^Превышен таймаут запроса \(50ms\)\. Запрос POST мог выполниться на сервере/
    );
    expect(err.nextSteps?.[0]).toContain('Не повторяйте запрос вслепую');
    expect(count).toBe(1);
  });

  it('POST network error keeps status 0 and warns; GET timeout message is unchanged', async () => {
    server.use(
      http.post(`${ORIGIN}/odata/Activity`, () => HttpResponse.error()),
      http.get(`${ORIGIN}/odata/Activity`, async () => {
        await new Promise((r) => setTimeout(r, 300));
        return HttpResponse.json({ value: [] });
      })
    );
    const client = new HttpClient(makeCfg({ request_timeout: 50 }));
    client.setAllowedOrigin(ORIGIN);

    const postErr = (await runWithAuth(auth(), () =>
      client.request({ method: 'POST', url: `${ORIGIN}/odata/Activity`, body: { Title: 'x' } })
    ).catch((e: unknown) => e)) as BpmApiError;
    expect(postErr.httpStatus).toBe(0);
    expect(postErr.message).toMatch(/^Сетевая ошибка: .*Запрос POST мог выполниться на сервере/);
    expect(postErr.nextSteps).toBeDefined();

    const getErr = (await runWithAuth(auth(), () =>
      client.request({ method: 'GET', url: `${ORIGIN}/odata/Activity` })
    ).catch((e: unknown) => e)) as BpmApiError;
    expect(getErr).toMatchObject({ httpStatus: 408, message: 'Превышен таймаут запроса (50ms)' });
    expect(getErr.nextSteps).toBeUndefined();
  });

  it('non-OData 500 body is surfaced in details instead of being dropped (and still retried)', async () => {
    let count = 0;
    server.use(
      http.delete(`${ORIGIN}/odata/ActivityDelete`, () => {
        count += 1;
        return HttpResponse.text('<html>Server Error in Application</html>', { status: 500 });
      })
    );
    onTestFinished(() => expect(count).toBe(1 + 3));

    const client = new HttpClient(makeCfg());
    client.setAllowedOrigin(ORIGIN);

    await expect(
      runWithAuth(auth(), () =>
        client.request({
          method: 'DELETE',
          url: `${ORIGIN}/odata/ActivityDelete`,
        })
      )
    ).rejects.toMatchObject({
      httpStatus: 500,
      details: expect.stringContaining('Server Error in Application'),
    });
  }, 20000);
});
