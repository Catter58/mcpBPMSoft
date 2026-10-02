import { describe, expect, it } from 'vitest';
import { registerEnumTool } from '../../src/tools/enum-tool.js';
import { ODataClient } from '../../src/client/odata-client.js';
import { extractAuthFromHeaders, getRequestAuth, runWithAuth } from '../../src/auth/request-context.js';
import type { BpmConfig } from '../../src/types/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { MockHttpClient } from '../setup/mock-http-client.js';

const config: BpmConfig = {
  bpmsoft_url: 'https://bpm.test',
  odata_version: 4,
  platform: 'net8',
  page_size: 100,
  max_batch_size: 100,
  lookup_cache_ttl: 300,
  request_timeout: 30000,
  max_file_size: 1000,
};
type Args = { collection: string; field: string; top?: number; cursor?: string };
const records = Array.from({ length: 5 }, (_, i) => ({ Id: `id-${i + 1}`, Name: `City ${i + 1}` }));

function setup(recordCount = 5, serverPageSize = 2) {
  const http = new MockHttpClient();
  http.setFallback((request) => {
    const url = new URL(request.url);
    const skip = Number(url.searchParams.get('$skip') || 0);
    const top = Number(url.searchParams.get('$top') || 100);
    const session = getRequestAuth()?.cookies.get('BPMSESSIONID') || 'local';
    const selected = records
      .slice(0, recordCount)
      .slice(skip, skip + Math.min(top, serverPageSize))
      .map((record) => ({ ...record, Name: `${session}: ${record.Name}` }));
    const hasMore = skip + selected.length < recordCount && selected.length < top;
    const next = new URL(url);
    next.searchParams.set('$skip', String(skip + selected.length));
    next.searchParams.set('$top', String(top - selected.length));
    return {
      data: {
        value: selected,
        '@odata.count': recordCount,
        ...(hasMore ? { '@odata.nextLink': next.toString() } : {}),
      },
    };
  });
  const services = {
    initialized: true,
    config,
    authManager: { async ensureAuthenticated() {} },
    odataClient: new ODataClient(config, http as never),
    metadataManager: {
      async resolveCollectionReference(query: string) {
        return { name: query };
      },
      async resolveFieldReference(_collection: string, field: string) {
        return { name: field };
      },
      async getLookupInfo() {
        return { lookupCollection: 'City', displayColumn: 'Name', navigationProperty: 'City' };
      },
    },
  };
  let handler: (args: Args) => Promise<CallToolResult>;
  registerEnumTool(
    {
      registerTool(_name: string, _definition: unknown, fn: typeof handler) {
        handler = fn;
      },
    } as never,
    services as never
  );
  const call = (args: Partial<Args> = {}) => handler({ collection: 'Contact', field: 'CityId', ...args });
  return { http, call, services };
}

describe('enum tool real handler with paginated OData', () => {
  it('keeps the connection cache when HTTP creates a fresh tool registration', async () => {
    const env = setup();
    await env.call({ top: 2 });
    let handler: (args: Args) => Promise<CallToolResult>;
    registerEnumTool(
      {
        registerTool(_name: string, _definition: unknown, fn: typeof handler) {
          handler = fn;
        },
      } as never,
      env.services as never
    );
    const result = await handler!({ collection: 'Contact', field: 'CityId', top: 2 });
    expect(result.structuredContent).toMatchObject({ from_cache: true, count: 2 });
  });
  it('follows server pages and returns a continuation without skipped values', async () => {
    const { call } = setup();
    const first = await call({ top: 3 });
    expect(first.structuredContent).toMatchObject({
      count: 3,
      total_count: 5,
      has_more: true,
      values: [{ id: 'id-1' }, { id: 'id-2' }, { id: 'id-3' }],
    });
    const second = await call({ cursor: String(first.structuredContent!.next_cursor) });
    expect(second.structuredContent).toMatchObject({
      count: 2,
      has_more: false,
      values: [{ id: 'id-4' }, { id: 'id-5' }],
    });
    expect(second.structuredContent!.next_cursor).toBeUndefined();
  });
  it('a full final page does not imply more data', async () => {
    const { call } = setup(3, 10);
    const result = await call({ top: 3 });
    expect(result.structuredContent).toMatchObject({ count: 3, has_more: false });
  });
  it('caches within a session while isolating different callers', async () => {
    const { call, http } = setup(1, 10);
    const authA = extractAuthFromHeaders({ Cookie: 'BPMSESSIONID=a' });
    const authB = extractAuthFromHeaders({ Cookie: 'BPMSESSIONID=b' });
    const first = await runWithAuth(authA, () => call());
    const same = await runWithAuth(authA, () => call());
    const second = await runWithAuth(authB, () => call());
    expect(first.structuredContent!.values).toEqual([{ id: 'id-1', name: 'a: City 1' }]);
    expect(same.structuredContent!.from_cache).toBe(true);
    expect(second.structuredContent!.values).toEqual([{ id: 'id-1', name: 'b: City 1' }]);
    expect(http.requests).toHaveLength(2);
  });
  it('binds continuation to both caller and source field', async () => {
    const { call } = setup();
    const authA = extractAuthFromHeaders({ Cookie: 'BPMSESSIONID=a' });
    const authB = extractAuthFromHeaders({ Cookie: 'BPMSESSIONID=b' });
    const first = await runWithAuth(authA, () => call({ top: 2 }));
    const cursor = String(first.structuredContent!.next_cursor);
    expect((await runWithAuth(authB, () => call({ cursor }))).isError).toBe(true);
    expect((await runWithAuth(authA, () => call({ cursor, field: 'OtherCityId' }))).isError).toBe(true);
  });
  it('does not share values across initialized connections', async () => {
    const first = setup(1, 10);
    const second = setup(2, 10);
    await first.call();
    const result = await second.call();
    expect(result.structuredContent!.count).toBe(2);
    expect(result.structuredContent!.from_cache).toBe(false);
  });
  it('invalidates cached values and cursors when a mutable container reconnects', async () => {
    const { call, http, services } = setup(5, 10);
    const first = await call({ top: 2 });
    services.config = { ...services.config, bpmsoft_url: 'https://other.bpm.test' };
    const fresh = await call({ top: 2 });
    expect(fresh.structuredContent!.from_cache).toBe(false);
    expect(http.requests).toHaveLength(2);
    expect((await call({ cursor: String(first.structuredContent!.next_cursor) })).isError).toBe(true);
  });
});
