import { describe, it, expect, beforeEach } from 'vitest';
import { ODataClient } from '../../src/client/odata-client.js';
import { BpmApiError } from '../../src/utils/errors.js';
import { MockHttpClient } from '../setup/mock-http-client.js';
import { resetServerCapabilities } from '../../src/utils/server-capabilities.js';
import type { BpmConfig } from '../../src/types/index.js';

function makeCfg(overrides: Partial<BpmConfig> = {}): BpmConfig {
  return {
    bpmsoft_url: 'https://bpm.test',
    username: 'u',
    password: 'p',
    odata_version: 4,
    platform: 'net8',
    page_size: 100,
    max_batch_size: 100,
    lookup_cache_ttl: 300,
    request_timeout: 30000,
    max_file_size: 10 * 1024 * 1024,
    ...overrides,
  };
}

describe('ODataClient.buildCollectionPath', () => {
  it('v4: {base}/Contact', () => {
    const http = new MockHttpClient();
    const client = new ODataClient(makeCfg(), http as unknown as never);
    expect(client.buildCollectionPath('Contact')).toBe('https://bpm.test/odata/Contact');
  });

  it('v3: appends Collection if missing', () => {
    const http = new MockHttpClient();
    const client = new ODataClient(
      makeCfg({ odata_version: 3, platform: 'netframework' }),
      http as unknown as never
    );
    expect(client.buildCollectionPath('Contact')).toBe(
      'https://bpm.test/0/ServiceModel/EntityDataService.svc/ContactCollection'
    );
  });

  it('v3: does not double-suffix when already present', () => {
    const http = new MockHttpClient();
    const client = new ODataClient(
      makeCfg({ odata_version: 3, platform: 'netframework' }),
      http as unknown as never
    );
    expect(client.buildCollectionPath('ContactCollection')).toBe(
      'https://bpm.test/0/ServiceModel/EntityDataService.svc/ContactCollection'
    );
  });
});

describe('ODataClient.buildRecordPath', () => {
  const guid = '11111111-2222-3333-4444-555555555555';

  it('v4: {base}/Contact(<guid>)', () => {
    const http = new MockHttpClient();
    const client = new ODataClient(makeCfg(), http as unknown as never);
    expect(client.buildRecordPath('Contact', guid)).toBe(`https://bpm.test/odata/Contact(${guid})`);
  });

  it("v3: {base}/ContactCollection(guid'<guid>')", () => {
    const http = new MockHttpClient();
    const client = new ODataClient(
      makeCfg({ odata_version: 3, platform: 'netframework' }),
      http as unknown as never
    );
    expect(client.buildRecordPath('Contact', guid)).toBe(
      `https://bpm.test/0/ServiceModel/EntityDataService.svc/ContactCollection(guid'${guid}')`
    );
  });
});

describe('odata-client identifier validation', () => {
  function client() {
    const http = new MockHttpClient();
    return new ODataClient(makeCfg(), http as unknown as never);
  }
  it('rejects an unsafe collection name', () => {
    expect(() => client().buildCollectionPath('Contact?$expand=Account')).toThrow();
    expect(() => client().buildCollectionPath('Account/$batch')).toThrow();
  });
  it('rejects a non-GUID id', () => {
    expect(() => client().buildRecordPath('Contact', '1)/Account')).toThrow();
    expect(() => client().buildRecordPath('Contact', 'not-a-guid')).toThrow();
  });
  it('accepts a valid collection and GUID', () => {
    expect(() => client().buildCollectionPath('Contact')).not.toThrow();
    expect(() => client().buildRecordPath('Contact', '77a09b42-3b7b-46d1-be1f-2cd49b8ea656')).not.toThrow();
  });
});

describe('ODataClient.executeBatch', () => {
  it('throws BpmApiError when odata_version=3', async () => {
    const http = new MockHttpClient();
    const client = new ODataClient(
      makeCfg({ odata_version: 3, platform: 'netframework' }),
      http as unknown as never
    );
    await expect(client.executeBatch([{ method: 'GET', url: '/Contact' }])).rejects.toBeInstanceOf(
      BpmApiError
    );
  });
});

describe('ODataClient.executeBulk', () => {
  beforeEach(() => resetServerCapabilities());
  const coll = 'https://bpm.test/odata/Contact';
  const posts = [
    { method: 'POST' as const, url: coll, body: { Name: 'A' } },
    { method: 'POST' as const, url: coll, body: { Name: 'B' } },
  ];

  it('probes $batch once, then sends records in one $batch', async () => {
    const http = new MockHttpClient();
    http.setFallback((opts) => ({
      data: {
        responses: (opts.body as { requests: unknown[] }).requests.map(() => ({ status: 200, body: {} })),
      },
    }));
    const client = new ODataClient(makeCfg(), http as unknown as never);
    expect((await client.executeBulk(posts, false, coll)).mode).toBe('batch');
    expect((await client.executeBulk(posts, false, coll)).mode).toBe('batch');
    // проба + два пакета: вторая проба не нужна
    expect(http.requests.map((r) => r.url)).toEqual([
      'https://bpm.test/odata/$batch',
      'https://bpm.test/odata/$batch',
      'https://bpm.test/odata/$batch',
    ]);
    expect((http.requests[0].body as { requests: Array<{ method: string }> }).requests[0].method).toBe('GET');
  });

  it('falls back to one-by-one when the probe fails, records never go into $batch', async () => {
    const http = new MockHttpClient();
    http.setFallback((opts) => {
      if (opts.url.endsWith('$batch')) throw new BpmApiError('terminated', 0);
      return { status: 201, data: { Id: (opts.body as { Name: string }).Name } };
    });
    const client = new ODataClient(makeCfg(), http as unknown as never);
    const result = await client.executeBulk(posts, false, coll);
    expect(result.mode).toBe('single');
    expect(result.responses.map((r) => r.status)).toEqual([201, 201]);
    expect(http.requests.filter((r) => r.url.endsWith('$batch'))).toHaveLength(1);
    await client.executeBulk(posts, false, coll);
    expect(http.requests.filter((r) => r.url.endsWith('$batch'))).toHaveLength(1);
  });

  it('one-by-one stops on first error unless continue_on_error', async () => {
    const http = new MockHttpClient();
    let n = 0;
    http.setFallback(() => {
      if (++n === 1) throw new BpmApiError('bad', 400);
      return { status: 201, data: {} };
    });
    const client = new ODataClient(
      makeCfg({ odata_version: 3, platform: 'netframework' }),
      http as unknown as never
    );
    const stopped = await client.executeBulk(posts, false, coll);
    expect(stopped.responses.map((r) => r.status)).toEqual([400]);
    n = 0;
    const all = await client.executeBulk(posts, true, coll);
    expect(all.responses.map((r) => r.status)).toEqual([400, 201]);
  });

  it('does not latch on auth failure of the probe', async () => {
    const http = new MockHttpClient();
    http.setFallback(() => {
      throw new BpmApiError('no', 401);
    });
    const client = new ODataClient(makeCfg(), http as unknown as never);
    await expect(client.executeBulk(posts, false, coll)).rejects.toBeInstanceOf(BpmApiError);
    http.setFallback((opts) => ({
      data: {
        responses: (opts.body as { requests: unknown[] }).requests.map(() => ({ status: 200, body: {} })),
      },
    }));
    expect((await client.executeBulk(posts, false, coll)).mode).toBe('batch');
  });
});

describe('ODataClient.getRecords with auto-pagination', () => {
  it('follows @odata.nextLink and concatenates pages', async () => {
    const http = new MockHttpClient();
    http.setResponses([
      () => ({
        status: 200,
        data: {
          value: [{ Id: '1' }, { Id: '2' }],
          '@odata.nextLink': 'https://bpm.test/odata/Contact?$skip=2',
        },
      }),
      () => ({
        status: 200,
        data: {
          value: [{ Id: '3' }],
        },
      }),
    ]);
    const client = new ODataClient(makeCfg(), http as unknown as never);

    const result = await client.getRecords('Contact', undefined, true);
    expect(result.value.map((r) => r.Id)).toEqual(['1', '2', '3']);
    // Two requests must have been made — one initial, one for the nextLink
    expect(http.requests).toHaveLength(2);
    expect(http.requests[0].url).toContain('/Contact');
    expect(http.requests[1].url).toBe('https://bpm.test/odata/Contact?$skip=2');
  });

  it('locks underlying HttpClient to BPMSoft origin (SSRF guard)', () => {
    const http = new MockHttpClient();
    new ODataClient(makeCfg(), http as unknown as never);
    expect(http.allowedOrigin).toBe('https://bpm.test');
  });
});

describe('ODataClient.getRecords $count fallback', () => {
  const torn = () => {
    throw new BpmApiError('Сетевая ошибка: terminated', 0);
  };
  const page = () => ({ status: 200, data: { value: [{ Id: '1' }] } });
  const query = { $filter: 'OwnerId ne null', $top: 1, $count: true };

  it('retries without $count and fills @odata.count from /$count', async () => {
    const http = new MockHttpClient();
    http.setResponses([torn, page, () => ({ status: 200, data: '﻿42' })]);
    const client = new ODataClient(makeCfg(), http as unknown as never);

    const result = await client.getRecords('Activity', query);

    expect(result.value).toHaveLength(1);
    expect(result['@odata.count']).toBe(42);
    expect(http.requests).toHaveLength(3);
    expect(http.requests[0].url).toContain('%24count=true');
    expect(http.requests[1].url).not.toContain('count');
    expect(http.requests[2].url).toContain('/Activity/$count?%24filter=OwnerId+ne+null');
    expect(http.requests[2].contentKind).toBe('count');
  });

  it('leaves count absent when /$count fails too', async () => {
    const http = new MockHttpClient();
    http.setResponses([
      torn,
      page,
      () => {
        throw new BpmApiError('Exception has been thrown by the target of an invocation.', 500);
      },
    ]);
    const client = new ODataClient(makeCfg(), http as unknown as never);

    const result = await client.getRecords('Activity', query);

    expect(result.value).toHaveLength(1);
    expect(result['@odata.count']).toBeUndefined();
  });

  it('does not retry when $count was not requested or the error is not a query rejection', async () => {
    const http = new MockHttpClient();
    http.setResponses([torn]);
    const client = new ODataClient(makeCfg(), http as unknown as never);
    await expect(client.getRecords('Activity', { $filter: 'OwnerId ne null' })).rejects.toThrow('terminated');

    const http2 = new MockHttpClient();
    http2.setResponses([
      () => {
        throw new BpmApiError('Нет доступа', 403);
      },
    ]);
    const client2 = new ODataClient(makeCfg(), http2 as unknown as never);
    await expect(client2.getRecords('Activity', query)).rejects.toMatchObject({ httpStatus: 403 });
    expect(http2.requests).toHaveLength(1);
  });
});
