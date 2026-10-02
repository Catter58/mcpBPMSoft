import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../../src/client/http-client.js';
import { ODataClient, removeLowercaseFunctions } from '../../src/client/odata-client.js';
import { ProcessEngineClient } from '../../src/process/process-engine-client.js';
import { buildConfig } from '../../src/config.js';
import { runWithAuth, extractAuthFromHeaders } from '../../src/auth/request-context.js';
import { BpmApiError, formatToolError } from '../../src/utils/errors.js';
import { MockHttpClient } from '../setup/mock-http-client.js';
import { resetServerCapabilities } from '../../src/utils/server-capabilities.js';

const config = { ...buildConfig('https://bpm.test'), request_timeout: 1000, max_batch_size: 2 };
const id = '11111111-2222-3333-4444-555555555555';
function authenticatedClient() {
  const client = new HttpClient(config);
  client.setAllowEnvCreds(true);
  client.updateAuthState({ isAuthenticated: true, csrfToken: 'test' });
  return client;
}
function mockOdata() {
  const http = new MockHttpClient();
  const client = new ODataClient(config, http as unknown as HttpClient);
  return { http, client };
}
afterEach(() => vi.unstubAllGlobals());

describe('Compatibility between native optimizations and write safeguards', () => {
  it('writes metadata-known Decimal/Int64 batch values as exact numeric tokens without changing text fields', async () => {
    const fetch = vi.fn(async (_url: string, request: RequestInit) => {
      const wire = String(request.body);
      expect(wire).toContain('"Amount":9007199254740993.01');
      expect(wire).toContain('"Count":9223372036854775807');
      expect(wire).toContain('"Ratio":0.05');
      expect(wire).toContain('"Text":"00123"');
      const batch = JSON.parse(wire) as { requests: Array<{ headers: Record<string, string> }> };
      expect(batch.requests[0].headers['Content-Type']).not.toContain('IEEE754Compatible');
      return Response.json({ responses: [{ id: '1', status: 201, body: { Id: id } }] });
    });
    vi.stubGlobal('fetch', fetch);
    const client = new ODataClient(config, authenticatedClient());
    const body = {
      Amount: '9007199254740993.01',
      Count: '9223372036854775807',
      Ratio: '+.05',
      Text: '00123',
    };
    const result = await client.executeBatch([
      {
        method: 'POST',
        url: client.buildCollectionPath('Opportunity'),
        body,
        numericFields: ['Amount', 'Count', 'Ratio'],
      },
    ]);
    expect(result.responses[0].state).toBe('completed');
    expect(body.Amount).toBe('9007199254740993.01');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('validates all numeric batch bodies before dispatching any chunk', async () => {
    const { http, client } = mockOdata();
    await expect(
      client.executeBatch([
        {
          method: 'POST',
          url: client.buildCollectionPath('Opportunity'),
          body: { Amount: '1' },
          numericFields: ['Amount'],
        },
        {
          method: 'POST',
          url: client.buildCollectionPath('Opportunity'),
          body: { Amount: '2' },
          numericFields: ['Amount'],
        },
        {
          method: 'POST',
          url: client.buildCollectionPath('Opportunity'),
          body: { Amount: 'invalid' },
          numericFields: ['Amount'],
        },
      ])
    ).rejects.toMatchObject({ httpStatus: 400 });
    expect(http.requests).toHaveLength(0);
  });

  it('preserves conditional metadata requests and treats 304 as a successful unchanged result', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('<Edmx />', { headers: { 'Content-Type': 'application/xml', ETag: '"metadata-v1"' } })
      )
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    vi.stubGlobal('fetch', fetch);
    const client = new ODataClient(config, authenticatedClient());
    expect(await client.getMetadataXml()).toEqual({
      xml: '<Edmx />',
      etag: '"metadata-v1"',
      notModified: false,
    });
    expect(await client.getMetadataXml({ etag: '"metadata-v1"' })).toEqual({
      xml: '',
      etag: '"metadata-v1"',
      notModified: true,
    });
    expect(new Headers(fetch.mock.calls[1][1].headers).get('if-none-match')).toBe('"metadata-v1"');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('combines a requested update representation with the verified ETag', async () => {
    const { http, client } = mockOdata();
    http.setResponses([
      () => ({ data: { Id: id }, headers: { etag: '"v1"' } }),
      () => ({ data: { Id: id, Name: 'Changed' } }),
    ]);
    expect(
      await client.updateRecord(
        'Account',
        id,
        { Name: 'Changed' },
        {
          expectedEtag: '"v1"',
          returnRepresentation: true,
        }
      )
    ).toEqual({ Id: id, Name: 'Changed' });
    expect(http.requests[1].headers).toEqual({ 'If-Match': '"v1"', Prefer: 'return=representation' });
    expect(http.requests.map((request) => request.method)).toEqual(['GET', 'PATCH']);
  });

  it('stops sequential bulk writes after an unknown outcome even when continuing on ordinary errors', async () => {
    const http = new MockHttpClient();
    const client = new ODataClient(
      { ...config, odata_version: 3, platform: 'netframework' },
      http as unknown as HttpClient
    );
    const url = client.buildCollectionPath('Account');
    http.setResponses([
      () => ({ status: 201, data: { Id: id } }),
      () => {
        throw new BpmApiError(
          'Lost answer',
          503,
          undefined,
          undefined,
          undefined,
          undefined,
          'outcome_unknown'
        );
      },
    ]);
    const result = await client.executeBulk(
      [
        { method: 'POST', url, body: { Name: 'A' } },
        { method: 'POST', url, body: { Name: 'B' } },
        { method: 'POST', url, body: { Name: 'C' } },
      ],
      true,
      url
    );
    expect(result.mode).toBe('single');
    expect(result.responses.map(({ id, state }) => ({ id, state }))).toEqual([
      { id: '1', state: 'completed' },
      { id: '2', state: 'outcome_unknown' },
      { id: '3', state: 'not_executed' },
    ]);
    expect(http.requests).toHaveLength(2);
  });

  it('isolates batch support probes by caller and collection', async () => {
    resetServerCapabilities();
    const { http, client } = mockOdata();
    http.setFallback((request) => ({
      data: {
        responses: (request.body as { requests: Array<{ id: string }> }).requests.map(({ id }) => ({
          id,
          status: 200,
          body: {},
        })),
      },
    }));
    const call = async (caller: string, collection: string) =>
      runWithAuth({ csrfToken: 'test', cookies: new Map([['BPMSESSIONID', caller]]) }, () => {
        const url = client.buildCollectionPath(collection);
        return client.executeBulk([{ method: 'POST', url, body: { Name: 'Test' } }], false, url);
      });
    await call('alice', 'Account');
    await call('alice', 'Account');
    await call('bob', 'Account');
    await call('alice', 'Contact');
    const probes = http.requests.filter(
      (request) => (request.body as { requests: Array<{ method: string }> }).requests[0].method === 'GET'
    );
    expect(probes).toHaveLength(3);
    expect(http.requests).toHaveLength(7);
    resetServerCapabilities();
  });
});

describe('Side effects are never replayed after an indeterminate outcome', () => {
  it('does not repeat a POST that may have created the record before returning 503', async () => {
    let created = 0;
    const fetch = vi.fn(async () => {
      created++;
      return new Response('', { status: 503, headers: { 'Retry-After': '0' } });
    });
    vi.stubGlobal('fetch', fetch);
    try {
      await authenticatedClient().request({
        method: 'POST',
        url: 'https://bpm.test/odata/Account',
        body: { Name: 'Test' },
      });
      expect.fail('Must report an unknown outcome');
    } catch (error) {
      expect(formatToolError(error)).toMatchObject({ code: 'outcome_unknown', safe_to_retry: false });
    }
    expect(created).toBe(1);
  });

  it('treats process execution GET as a side effect', async () => {
    const fetch = vi.fn(async () => new Response('', { status: 503, headers: { 'Retry-After': '0' } }));
    vi.stubGlobal('fetch', fetch);
    const process = new ProcessEngineClient(config, authenticatedClient());
    await expect(process.execute('TestProcess')).rejects.toMatchObject({ code: 'outcome_unknown' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reports connection loss and an unreadable success body as unknown mutations', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    vi.stubGlobal('fetch', fetch);
    await expect(
      authenticatedClient().request({ method: 'PATCH', url: 'https://bpm.test/odata/Account', body: {} })
    ).rejects.toMatchObject({ code: 'outcome_unknown' });
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockImplementation(
      async () => new Response('{invalid', { headers: { 'Content-Type': 'application/json' } })
    );
    await expect(
      authenticatedClient().request({ method: 'POST', url: 'https://bpm.test/odata/Account', body: {} })
    ).rejects.toMatchObject({ code: 'outcome_unknown' });
  });

  it('reports an interrupted mutation as unknown and cancellation before dispatch as network', async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async () => {
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    vi.stubGlobal('fetch', fetch);
    await expect(
      authenticatedClient().request({
        method: 'PATCH',
        url: 'https://bpm.test/odata/Account',
        body: {},
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ code: 'outcome_unknown' });
    await expect(
      authenticatedClient().request({
        method: 'PATCH',
        url: 'https://bpm.test/odata/Account',
        body: {},
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ code: 'network' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('requests lossless v4 Decimal/Int64 representation from the platform', async () => {
    const fetch = vi.fn(async (_url: string, options: RequestInit) => {
      expect(new Headers(options.headers).get('accept')).toContain('IEEE754Compatible=true');
      expect(new Headers(options.headers).get('content-type')).toContain('IEEE754Compatible=true');
      return Response.json({ value: [{ Amount: '9007199254740993.01' }] });
    });
    vi.stubGlobal('fetch', fetch);
    const response = await authenticatedClient().request<{ value: Array<{ Amount: string }> }>({
      method: 'GET',
      url: 'https://bpm.test/odata/Opportunity',
    });
    expect(response.data.value[0].Amount).toBe('9007199254740993.01');
  });

  it('retains definite validation errors even when the server returns malformed JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response('{invalid', { status: 400, headers: { 'Content-Type': 'application/json' } })
      )
    );
    await expect(
      authenticatedClient().request({ method: 'POST', url: 'https://bpm.test/odata/Account', body: {} })
    ).rejects.toMatchObject({ code: 'validation', httpStatus: 400 });
  });

  it('still retries a safe read on 503', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 503, headers: { 'Retry-After': '0' } }))
      .mockResolvedValueOnce(Response.json({ value: [] }));
    vi.stubGlobal('fetch', fetch);
    await expect(
      authenticatedClient().request({ method: 'GET', url: 'https://bpm.test/odata/Account' })
    ).resolves.toMatchObject({ status: 200 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('shares concurrent reauthentication and only retries each rejected request once', async () => {
    const client = authenticatedClient();
    let reauthenticated = false;
    const fetch = vi.fn(async () =>
      reauthenticated ? Response.json({ value: [] }) : new Response('', { status: 401 })
    );
    vi.stubGlobal('fetch', fetch);
    const reauth = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      reauthenticated = true;
    });
    client.setReauthHandler(reauth);
    await Promise.all([
      client.request({ method: 'GET', url: 'https://bpm.test/odata/Account' }),
      client.request({ method: 'GET', url: 'https://bpm.test/odata/Contact' }),
    ]);
    expect(reauth).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});

describe('Truthful bounded pagination', () => {
  it('enforces maxRecords on a single oversized final page and preserves its unreturned rows', async () => {
    const { http, client } = mockOdata();
    http.setResponses([
      () => ({ data: { value: [1, 2, 3, 4, 5], '@odata.count': 5 } }),
      () => ({ data: { value: [3, 4, 5] } }),
    ]);
    const first = await client.getRecords<number>('Account', { $top: 3, $orderby: 'Name asc' }, false, 2);
    expect(first.value).toEqual([1, 2]);
    const next = new URL(first['@odata.nextLink']!);
    expect(next.searchParams.get('$skip')).toBe('2');
    expect(next.searchParams.get('$orderby')).toBe('Name asc,Id asc');
    const second = await client.getNextPage<number>('Account', first['@odata.nextLink']!, 2);
    expect(second.value).toEqual([3, 4]);
    expect(new URL(second['@odata.nextLink']!).searchParams.get('$skip')).toBe('4');
  });

  it('never advances to a server link past clipped rows in auto-pagination', async () => {
    const { http, client } = mockOdata();
    http.setResponses([
      () => ({ data: { value: [1, 2], '@odata.nextLink': 'Account?$skip=2' } }),
      () => ({ data: { value: [3, 4, 5, 6], '@odata.nextLink': 'Account?$skip=6' } }),
    ]);
    const result = await client.getRecords<number>('Account', { $top: 5 }, true, 4);
    expect(result.value).toEqual([1, 2, 3, 4]);
    expect(new URL(result['@odata.nextLink']!).searchParams.get('$skip')).toBe('4');
  });

  it('normalizes v3 envelopes, counts, and query-relative continuations', async () => {
    const http = new MockHttpClient();
    const client = new ODataClient(
      { ...config, odata_version: 3, platform: 'netframework' },
      http as unknown as HttpClient
    );
    http.setResponses([
      () => ({ data: { d: { results: [1], __next: '?$skip=1', __count: '2' } } }),
      () => ({ data: { d: { results: [2] } } }),
    ]);
    const result = await client.getRecords<number>('Account', { $count: true }, true);
    expect(result).toMatchObject({ value: [1, 2], '@odata.count': 2 });
    expect(result['@odata.nextLink']).toBeUndefined();
    expect(new URL(http.requests[0].url).searchParams.get('$inlinecount')).toBe('allpages');
    expect(http.requests[1].url).toContain('AccountCollection?');
  });

  it('preserves an in-page cursor when resuming a skiptoken page', async () => {
    const { http, client } = mockOdata();
    http.setFallback(() => ({ data: { value: [1, 2, 3, 4], '@odata.nextLink': 'Account?$skiptoken=next' } }));
    const first = await client.getNextPage<number>('Account', 'Account?$skiptoken=first', 2);
    expect(first.value).toEqual([1, 2]);
    expect(first['@odata.nextLink']).toContain('#mcp-offset=2');
    const second = await client.getNextPage<number>('Account', first['@odata.nextLink']!, 2);
    expect(second.value).toEqual([3, 4]);
    expect(second['@odata.nextLink']).toBe('Account?$skiptoken=next');
    expect(http.requests.every((request) => !request.url.includes('#'))).toBe(true);
  });

  it('rejects another origin and another collection before dispatch', async () => {
    const { http, client } = mockOdata();
    await expect(client.getNextPage('Account', 'https://other.test/odata/Account')).rejects.toBeInstanceOf(
      BpmApiError
    );
    await expect(client.getNextPage('Account', 'Contact?$skip=2')).rejects.toBeInstanceOf(BpmApiError);
    expect(http.requests).toHaveLength(0);
  });
});

describe('Create reconciliation and conditional writes', () => {
  it('reuses an existing deterministic UUID only for matching data', async () => {
    const { http, client } = mockOdata();
    http.setFallback(() => ({ data: { Id: id, Name: 'Expected' } }));
    expect(await client.createRecordWithOutcome('Account', { Name: 'Expected' }, { id })).toEqual({
      record: { Id: id, Name: 'Expected' },
      created: false,
    });
    expect(http.requests.map((request) => request.method)).toEqual(['GET']);
    expect(await client.createRecord('Account', { Name: 'Expected' }, { id })).toEqual({
      Id: id,
      Name: 'Expected',
    });
    await expect(client.createRecord('Account', { Name: 'Different' }, { id })).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
    expect(http.requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('reports a successful POST as created without adding a result-verification request', async () => {
    const { http, client } = mockOdata();
    http.setResponses([
      () => {
        throw new BpmApiError('Absent', 404);
      },
      () => ({ status: 201, data: { Id: id, Name: 'Expected' } }),
    ]);
    expect(await client.createRecordWithOutcome('Account', { Name: 'Expected' }, { id })).toEqual({
      record: { Id: id, Name: 'Expected' },
      created: true,
    });
    expect(http.requests.map((request) => request.method)).toEqual(['GET', 'POST']);
  });

  it('recovers an uncertain POST by reading its known UUID without repeating creation', async () => {
    const { http, client } = mockOdata();
    http.setResponses([
      () => {
        throw new BpmApiError('Absent', 404);
      },
      () => {
        throw new BpmApiError(
          'Lost answer',
          503,
          undefined,
          undefined,
          undefined,
          undefined,
          'outcome_unknown'
        );
      },
      () => ({ data: { Id: id, Name: 'Expected' } }),
    ]);
    expect(await client.createRecordWithOutcome('Account', { Name: 'Expected' }, { id })).toEqual({
      record: { Id: id, Name: 'Expected' },
      created: null,
    });
    expect(http.requests.map((request) => request.method)).toEqual(['GET', 'POST', 'GET']);
    expect(http.requests[1].body).toMatchObject({ Id: id });
  });

  it('uses transport ETag and blocks writes when the platform has no conditional-write support', async () => {
    const { http, client } = mockOdata();
    http.setFallback(() => ({ data: { Id: id } }));
    await expect(
      client.updateRecord('Account', id, { Name: 'Changed' }, { expectedEtag: '"v1"' })
    ).rejects.toMatchObject({ code: 'concurrency_unsupported' });
    expect(http.requests).toHaveLength(1);
    http.setResponses([() => ({ data: { Id: id }, headers: { etag: '"v2"' } })]);
    await expect(client.deleteRecord('Account', id, { expectedEtag: '"v1"' })).rejects.toMatchObject({
      code: 'concurrency_conflict',
    });
    http.setResponses([() => ({ data: { Id: id }, headers: { etag: '"v1"' } }), () => ({ status: 204 })]);
    await client.updateRecord('Account', id, { Name: 'Changed' }, { expectedEtag: '"v1"' });
    expect(http.requests.at(-1)?.headers).toEqual({ 'If-Match': '"v1"' });
  });
});

describe('Batch results retain exact input identities and uncertainty', () => {
  const requests = [1, 2, 3].map(() => ({
    method: 'POST',
    url: 'https://bpm.test/odata/Account',
    body: { Name: 'Test' },
  }));
  it('orders shuffled responses by request ID and stops later chunks on failure', async () => {
    const { http, client } = mockOdata();
    http.setResponses([
      () => ({
        data: {
          responses: [
            { id: '2', status: 400 },
            { id: '1', status: 201, body: { Id: id } },
          ],
        },
      }),
    ]);
    const result = await client.executeBatch(requests, false);
    expect(result.responses.map((response) => [response.id, response.state])).toEqual([
      ['1', 'completed'],
      ['2', 'failed'],
      ['3', 'not_executed'],
    ]);
    expect(http.requests).toHaveLength(1);
  });

  it('preserves completed chunks when a later response is lost', async () => {
    const { http, client } = mockOdata();
    http.setResponses([
      () => ({
        data: {
          responses: [
            { id: '1', status: 201 },
            { id: '2', status: 201 },
          ],
        },
      }),
      () => {
        throw new BpmApiError(
          'Lost answer',
          503,
          undefined,
          undefined,
          undefined,
          undefined,
          'outcome_unknown'
        );
      },
    ]);
    const result = await client.executeBatch(requests, true);
    expect(result.responses.map((response) => response.state)).toEqual([
      'completed',
      'completed',
      'outcome_unknown',
    ]);
  });

  it('never guesses a missing response ID from array position', async () => {
    const { http, client } = mockOdata();
    http.setResponses([() => ({ data: { responses: [{ status: 201 }, { id: '2', status: 201 }] } })]);
    const result = await client.executeBatch(requests, true);
    expect(result.responses.map((response) => response.state)).toEqual([
      'outcome_unknown',
      'completed',
      'not_executed',
    ]);
    expect(http.requests).toHaveLength(1);
  });
});

describe('native collation compatibility for broken tolower implementations', () => {
  const filtered = "contains(tolower(Name),'mixedcase') and tolower(Account/Name) eq 'company'";
  function terminated() {
    return new BpmApiError(
      'Сетевая ошибка: terminated',
      0,
      undefined,
      undefined,
      undefined,
      undefined,
      'network'
    );
  }
  it('removes only actual field wrappers, preserving string literals and escaped apostrophes', () => {
    expect(
      removeLowercaseFunctions(
        "contains(tolower(Name),'tolower(Name) O''Brien') and tolower(Owner/Name) eq 'x'"
      )
    ).toBe("contains(Name,'tolower(Name) O''Brien') and Owner/Name eq 'x'");
    expect(removeLowercaseFunctions("contains(Name,'tolower(Name)') and Mytolower(Name) eq 'x'")).toBe(
      "contains(Name,'tolower(Name)') and Mytolower(Name) eq 'x'"
    );
  });
  it('recovers a terminated response with a plain-field read and exposes compatibility notes', async () => {
    const { http, client } = mockOdata();
    http.setResponses([
      () => {
        throw terminated();
      },
      (request) => {
        expect(new URL(request.url).searchParams.get('$filter')).toBe(
          "contains(Name,'mixedcase') and Account/Name eq 'company'"
        );
        return { data: { value: [{ Id: id, Name: 'MixedCase' }] } };
      },
    ]);
    const result = await client.getRecords('Account', { $filter: filtered });
    expect(result.value).toHaveLength(1);
    expect(result.matching).toBe('platform_collation');
    expect(result.warnings?.[0]).toContain('коллацию');
    expect(http.requests.every((request) => request.method === 'GET')).toBe(true);
  });
  it('applies the same fallback to count without changing its numeric contract', async () => {
    const { http, client } = mockOdata();
    http.setResponses([
      () => {
        throw new BpmApiError('Function tolower is not supported', 400);
      },
      (request) => {
        expect(new URL(request.url).searchParams.get('$filter')).toBe(
          "contains(Name,'mixedcase') and Account/Name eq 'company'"
        );
        return { data: '42' };
      },
    ]);
    expect(await client.getCountWithDetails('Account', filtered)).toMatchObject({
      count: 42,
      matching: 'platform_collation',
    });
  });
  it('never retries unrelated validation, permission, generic network or timeout errors', async () => {
    for (const error of [
      new BpmApiError('Invalid property Name', 400),
      new BpmApiError('Denied', 403),
      new BpmApiError('fetch failed', 0, undefined, undefined, undefined, undefined, 'network'),
      new BpmApiError('Timeout: terminated', 408, undefined, undefined, undefined, undefined, 'network'),
    ]) {
      const { http, client } = mockOdata();
      http.setResponses([
        () => {
          throw error;
        },
      ]);
      await expect(client.getRecords('Account', { $filter: filtered })).rejects.toBe(error);
      expect(http.requests).toHaveLength(1);
    }
  });
  it('preserves the original failure if fallback fails, or if tolower occurs only in a quoted value', async () => {
    const original = terminated();
    const { http, client } = mockOdata();
    http.setResponses([
      () => {
        throw original;
      },
      () => {
        throw new BpmApiError('Denied', 403);
      },
    ]);
    await expect(client.getRecords('Account', { $filter: filtered })).rejects.toBe(original);
    expect(http.requests).toHaveLength(2);
    http.setResponses([
      () => {
        throw original;
      },
    ]);
    await expect(client.getRecords('Account', { $filter: "Name eq 'tolower(Name)'" })).rejects.toBe(original);
    expect(http.requests).toHaveLength(3);
  });
});

it('caches proven native collation per collection and auth context, shares it with counts, and expires it', async () => {
  const { http, client } = mockOdata();
  const filter = "contains(tolower(Name),'mixed')";
  const error = new BpmApiError(
    'Сетевая ошибка: terminated',
    0,
    undefined,
    undefined,
    undefined,
    undefined,
    'network'
  );
  const a = extractAuthFromHeaders({ BPMCSRF: 'a', Cookie: 'BPMSESSIONID=a' });
  const b = extractAuthFromHeaders({ BPMCSRF: 'b', Cookie: 'BPMSESSIONID=b' });
  const date = vi.spyOn(Date, 'now').mockReturnValue(1000);
  try {
    http.setResponses([
      () => {
        throw error;
      },
      () => ({ data: { value: [{ Id: id }] } }),
      (request) => {
        expect(new URL(request.url).searchParams.get('$filter')).toBe("contains(Name,'mixed')");
        return { data: '1' };
      },
      (request) => {
        expect(new URL(request.url).searchParams.get('$filter')).toBe(filter);
        return { data: { value: [] } };
      },
      (request) => {
        expect(new URL(request.url).searchParams.get('$filter')).toBe(filter);
        return { data: { value: [] } };
      },
      (request) => {
        expect(new URL(request.url).searchParams.get('$filter')).toBe(filter);
        return { data: { value: [] } };
      },
    ]);
    await runWithAuth(a, () => client.getRecords('Account', { $filter: filter }));
    const count = await runWithAuth(a, () => client.getCountWithDetails('Account', filter));
    expect(count.matching).toBe('platform_collation');
    await runWithAuth(b, () => client.getRecords('Account', { $filter: filter }));
    await runWithAuth(a, () => client.getRecords('Contact', { $filter: filter }));
    date.mockReturnValue(1000 + config.lookup_cache_ttl * 1000 + 1);
    await runWithAuth(a, () => client.getRecords('Account', { $filter: filter }));
    expect(http.requests).toHaveLength(6);
  } finally {
    date.mockRestore();
  }
});

it('never caches an invalid plain response and forgets compatibility after cached permission rejection', async () => {
  const { http, client } = mockOdata();
  const filter = "contains(tolower(Name),'mixed')";
  const failure = new BpmApiError('Function tolower is not supported', 400);
  http.setResponses([
    () => {
      throw failure;
    },
    () => ({ data: '<html>Login required</html>' }),
    (request) => {
      expect(new URL(request.url).searchParams.get('$filter')).toBe(filter);
      throw failure;
    },
    () => ({ data: { value: [] } }),
    () => {
      throw new BpmApiError('Denied', 403);
    },
    (request) => {
      expect(new URL(request.url).searchParams.get('$filter')).toBe(filter);
      return { data: { value: [] } };
    },
  ]);
  await expect(client.getRecords('Account', { $filter: filter })).rejects.toBe(failure);
  await client.getRecords('Account', { $filter: filter });
  await expect(client.getRecords('Account', { $filter: filter })).rejects.toMatchObject({ httpStatus: 403 });
  await client.getRecords('Account', { $filter: filter });
  expect(http.requests).toHaveLength(6);
});
