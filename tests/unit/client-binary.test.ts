import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../../src/client/http-client.js';
import { ODataClient } from '../../src/client/odata-client.js';
import { buildConfig } from '../../src/config.js';
import { MockHttpClient } from '../setup/mock-http-client.js';

const config = buildConfig('https://bpm.test');
const id = '11111111-2222-3333-4444-555555555555';

function authenticatedHttp() {
  const client = new HttpClient(config);
  client.setAllowEnvCreds(true);
  client.updateAuthState({ isAuthenticated: true, csrfToken: 'test' });
  return client;
}

afterEach(() => vi.unstubAllGlobals());

describe('Binary response decoding', () => {
  it('returns an empty Buffer for a 204 named stream, preserving other empty response types', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 }))
    );
    const http = authenticatedHttp();
    const odata = new ODataClient(config, http);
    const empty = await odata.getFieldBinary('SysImage', id, 'Data', { fieldType: 'Edm.Stream' });
    expect(Buffer.isBuffer(empty)).toBe(true);
    expect(empty.byteLength).toBe(0);
    await expect(
      http.request({ method: 'GET', url: 'https://bpm.test/odata/empty', responseType: 'text' })
    ).resolves.toMatchObject({ data: '' });
    await expect(
      http.request({ method: 'DELETE', url: 'https://bpm.test/odata/empty' })
    ).resolves.toMatchObject({ data: {} });
  });

  it('roundtrips raw bytes without decoding the response as JSON', async () => {
    let stored = Buffer.alloc(0);
    const fetch = vi.fn(async (_url: string, options: RequestInit) => {
      if (options.method === 'PUT') {
        stored = Buffer.from(options.body as Uint8Array);
        return new Response(null, { status: 204 });
      }
      return new Response(Uint8Array.from(stored), { headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetch);
    const odata = new ODataClient(config, authenticatedHttp());
    const original = Buffer.from([0, 255, 123, 1, 2, 10, 13]);
    await odata.putFieldBinary('SysImage', id, 'Data', original, { fieldType: 'Edm.Stream' });
    expect(await odata.getFieldBinary('SysImage', id, 'Data', { fieldType: 'Edm.Stream' })).toEqual(original);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('EDM-aware binary routes', () => {
  it.each([3, 4] as const)('uses the metadata type for all raw methods in OData %s', async (version) => {
    const http = new MockHttpClient();
    http.setFallback(() => ({ data: Buffer.alloc(0) }));
    const client = new ODataClient(
      { ...config, odata_version: version, platform: version === 3 ? 'netframework' : 'net8' },
      http as unknown as HttpClient
    );
    for (const fieldType of ['Edm.Stream', 'Edm.Binary'] as const) {
      await client.getFieldBinary('Document', id, 'Data', { fieldType });
      await client.putFieldBinary('Document', id, 'Data', Buffer.from('test'), { fieldType });
      await client.deleteFieldBinary('Document', id, 'Data', { fieldType });
    }
    expect(http.requests.map((request) => request.url)).toEqual([
      ...Array<string>(3).fill(`${client.buildRecordPath('Document', id)}/Data`),
      ...Array<string>(3).fill(`${client.buildRecordPath('Document', id)}/Data/$value`),
    ]);
    expect(http.requests.map((request) => request.method)).toEqual([
      'GET',
      'PUT',
      'DELETE',
      'GET',
      'PUT',
      'DELETE',
    ]);
  });

  it('preserves legacy routes when metadata type is omitted', async () => {
    const http = new MockHttpClient();
    http.setFallback(() => ({ data: Buffer.alloc(0) }));
    const client = new ODataClient(
      { ...config, odata_version: 3, platform: 'netframework' },
      http as unknown as HttpClient
    );
    await client.getFieldBinary('Document', id, 'Data');
    await client.putFieldBinary('Document', id, 'Data', Buffer.from('test'));
    await client.deleteFieldBinary('Document', id, 'Data');
    const url = `${client.buildRecordPath('Document', id)}/Data`;
    expect(http.requests.map((request) => request.url)).toEqual([`${url}/$value`, url, url]);
  });

  it('rejects unsafe field identifiers before dispatch', async () => {
    const http = new MockHttpClient();
    const client = new ODataClient(config, http as unknown as HttpClient);
    await expect(client.getFieldBinary('Document', id, 'Data/$value')).rejects.toThrow();
    expect(http.requests).toHaveLength(0);
  });
});
