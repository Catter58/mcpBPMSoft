import { describe, it, expect } from 'vitest';
import { ODataClient } from '../../src/client/odata-client.js';
import { BpmApiError } from '../../src/utils/errors.js';
import { MockHttpClient } from '../setup/mock-http-client.js';
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
    expect(client.buildRecordPath('Contact', guid)).toBe(
      `https://bpm.test/odata/Contact(${guid})`
    );
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
