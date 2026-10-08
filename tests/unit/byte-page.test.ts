import { describe, expect, it } from 'vitest';
import { MetadataManager } from '../../src/metadata/metadata-manager.js';
import { registerReadTools } from '../../src/tools/read-tools.js';
import type { ServiceContainer } from '../../src/tools/init-tool.js';
import type { BpmConfig } from '../../src/types/index.js';
import { SIMPLE_EDMX } from '../setup/fixtures/edmx.js';
import { decodeCursor, encodeCursor } from '../../src/utils/cursor.js';
import { READ_RESULT_BYTE_LIMIT, serializedResultBytes } from '../../src/server/response-budget.js';
import { limitResultText } from '../../src/server/instrumentation.js';
import { continuationAfter } from '../../src/client/odata-client.js';
import { ODataClient } from '../../src/client/odata-client.js';
import { MockHttpClient } from '../setup/mock-http-client.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { instrumentTools } from '../../src/server/instrumentation.js';

const ID = '11111111-2222-3333-4444-555555555555';
type ReadHandler = (params: Record<string, unknown>) => Promise<CallToolResult>;

function resultData(result: CallToolResult): Record<string, unknown> {
  return result.structuredContent ?? {};
}

function manager(): MetadataManager {
  const config = {
    bpmsoft_url: 'https://bpm.test',
    odata_version: 4,
    platform: 'net8',
    lookup_cache_ttl: 300,
  } as BpmConfig;
  return new MetadataManager(
    config,
    { getMetadataXml: async () => ({ xml: SIMPLE_EDMX }) } as never,
    {
      request: async () => ({ data: { value: [] } }),
    } as never
  );
}

function tool(odataClient: Record<string, unknown>) {
  const handlers = new Map<string, ReadHandler>();
  const server = {
    registerTool: (name: string, _options: unknown, handler: ReadHandler) => handlers.set(name, handler),
  };
  const services = {
    initialized: true,
    authManager: { ensureAuthenticated: async () => undefined },
    metadataManager: manager(),
    odataClient,
    config: { bpmsoft_url: 'https://bpm.test', username: 'test', odata_version: 4 },
    currentUser: { get: async () => ({}) },
  } as unknown as ServiceContainer;
  registerReadTools(server as never, services);
  return handlers.get('bpm_get_records')!;
}

describe('bounded auto-pagination pages', () => {
  it('returns a bounded prefix and continues at the first omitted row', async () => {
    const records = Array.from({ length: 9 }, (_, index) => ({ Id: `${index}`, Name: 'x'.repeat(9_000) }));
    const handler = tool({
      getRecords: async () => ({ value: records, '@odata.nextLink': 'https://bpm.test/Contact?$skip=9' }),
      previewCollectionUrl: (_collection: string, query: Record<string, unknown>) =>
        `https://bpm.test/Contact?$skip=${query.$skip}`,
    });
    const result = await handler({ collection: 'Contact', auto_paginate: true, max_records: 9 });
    expect(result.isError).not.toBe(true);
    expect(serializedResultBytes(result)).toBeLessThanOrEqual(READ_RESULT_BYTE_LIMIT);
    expect(serializedResultBytes(limitResultText(result))).toBeLessThanOrEqual(READ_RESULT_BYTE_LIMIT);
    const payload = resultData(result);
    expect(payload.has_more).toBe(true);
    expect(payload.count as number).toBeLessThan(records.length);
    const state = decodeCursor(payload.cursor as string, 'https://bpm.test:test:records');
    expect(new URL(state.nextLink!).searchParams.get('$skip')).toBe(String(payload.count));
  });

  it('fills the budget beyond the first fitting geometric prefix', async () => {
    const records = Array.from({ length: 16 }, (_, index) => ({ Id: `${index}`, Name: 'x'.repeat(4_000) }));
    const handler = tool({
      getRecords: async () => ({ value: records, '@odata.nextLink': 'https://bpm.test/Contact?$skip=16' }),
      previewCollectionUrl: () => 'https://bpm.test/Contact?$skip=0',
    });
    const result = await handler({ collection: 'Contact', auto_paginate: true, max_records: 16 });
    expect(result.isError).not.toBe(true);
    expect(serializedResultBytes(result)).toBeLessThanOrEqual(READ_RESULT_BYTE_LIMIT);
    const payload = resultData(result);
    expect(payload.count as number).toBeGreaterThan(4);
    expect(payload.count as number).toBeLessThan(records.length);
    const state = decodeCursor(payload.cursor as string, 'https://bpm.test:test:records');
    expect(new URL(state.nextLink!).searchParams.get('$skip')).toBe(String(payload.count));
  });

  it('bounds fitting work for thousands of fetched rows', async () => {
    let nameReads = 0;
    const records = Array.from({ length: 5_000 }, (_, index) => {
      const record: Record<string, unknown> = { Id: `row-${index}` };
      Object.defineProperty(record, 'Name', {
        enumerable: true,
        get: () => {
          nameReads += 1;
          return 'n'.repeat(300);
        },
      });
      return record;
    });
    let requests = 0;
    let fetchedRows = 0;
    const handler = tool({
      getRecords: async (
        _collection: string,
        _query: Record<string, unknown>,
        _autoPaginate: boolean,
        maxRecords: number
      ) => {
        requests += 1;
        const page = records.slice(0, maxRecords);
        fetchedRows += page.length;
        return {
          value: page,
          ...(page.length < records.length
            ? { '@odata.nextLink': `https://bpm.test/Contact?$skip=${page.length}` }
            : {}),
        };
      },
      previewCollectionUrl: () => 'https://bpm.test/Contact?$skip=0',
    });
    const result = await handler({ collection: 'Contact', auto_paginate: true, max_records: 5_000 });
    const readsAtReturn = nameReads;
    expect(requests).toBe(1);
    expect(fetchedRows).toBeLessThan(records.length);
    expect(result.isError).not.toBe(true);
    expect(resultData(result).count as number).toBeGreaterThan(0);
    expect(resultData(result).count as number).toBeLessThan(records.length);
    expect(readsAtReturn).toBeLessThan(500_000);
  });

  it('fits the complete result after the real instrumentation text limit', async () => {
    const server = instrumentTools(new McpServer({ name: 'byte-page', version: '1' }));
    const odataClient = {
      getRecords: async () => ({
        value: Array.from({ length: 9 }, (_, index) => ({ Id: `${index}`, Name: 'x'.repeat(5_000) })),
        '@odata.nextLink': 'https://bpm.test/Contact?$skip=9',
      }),
      previewCollectionUrl: () => 'https://bpm.test/Contact?$skip=0',
    };
    const services = {
      initialized: true,
      authManager: { ensureAuthenticated: async () => undefined },
      metadataManager: manager(),
      odataClient,
      config: { bpmsoft_url: 'https://bpm.test', username: 'test', odata_version: 4 },
      currentUser: { get: async () => ({}) },
    } as unknown as ServiceContainer;
    registerReadTools(server, services);
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'byte-page-test', version: '1' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    await client.listTools();
    const result = await client.callTool({
      name: 'bpm_get_records',
      arguments: { collection: 'Contact', auto_paginate: true, max_records: 9, format: 'full' },
    });
    await client.close();
    expect(result.isError).not.toBe(true);
    expect(serializedResultBytes(result)).toBeLessThanOrEqual(READ_RESULT_BYTE_LIMIT);
    expect(result.structuredContent).toBeTruthy();
  });

  it('inherits bounded paging for cursor-only continuation calls', async () => {
    const rows = Array.from({ length: 80 }, (_, index) => ({ Id: `row-${index}`, Name: 'p'.repeat(9_000) }));
    const requested: string[] = [];
    const odataClient = {
      getRecords: async () => ({ value: rows, '@odata.nextLink': 'https://bpm.test/Contact?$skip=80' }),
      getNextPage: async (_collection: string, link: string) => {
        requested.push(link);
        const skip = Number(new URL(link).searchParams.get('$skip') ?? 0);
        return { value: rows.slice(skip), '@odata.nextLink': 'https://bpm.test/Contact?$skip=80' };
      },
      previewCollectionUrl: () => 'https://bpm.test/Contact?$skip=0',
    };
    const server = instrumentTools(new McpServer({ name: 'cursor-byte-page', version: '1' }));
    const services = {
      initialized: true,
      authManager: { ensureAuthenticated: async () => undefined },
      metadataManager: manager(),
      odataClient,
      config: { bpmsoft_url: 'https://bpm.test', username: 'test', odata_version: 4 },
      currentUser: { get: async () => ({}) },
    } as unknown as ServiceContainer;
    registerReadTools(server, services);
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'cursor-byte-page-test', version: '1' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    await client.listTools();

    const first = await client.callTool({
      name: 'bpm_get_records',
      arguments: { collection: 'Contact', auto_paginate: true, max_records: 80, resolve_references: false },
    });
    expect(first.isError).not.toBe(true);
    expect(serializedResultBytes(first)).toBeLessThanOrEqual(READ_RESULT_BYTE_LIMIT);
    const firstData = resultData(first);
    const firstRows = firstData.records as Array<{ Id: string }>;
    expect(firstRows.length).toBeGreaterThan(0);
    expect(firstRows.length).toBeLessThan(rows.length);
    const firstCursor = firstData.cursor as string;
    expect(decodeCursor(firstCursor, 'https://bpm.test:test:records')).toMatchObject({
      autoPaginate: true,
      resolveReferences: false,
    });

    const next = await client.callTool({
      name: 'bpm_get_records',
      arguments: { cursor: firstCursor },
    });
    expect(next.isError).not.toBe(true);
    expect(serializedResultBytes(next)).toBeLessThanOrEqual(READ_RESULT_BYTE_LIMIT);
    const nextData = resultData(next);
    const nextRows = nextData.records as Array<{ Id: string }>;
    expect(nextRows.length).toBeGreaterThan(0);
    expect(nextRows.some((row) => firstRows.some((previous) => previous.Id === row.Id))).toBe(false);
    expect(decodeCursor(nextData.cursor as string, 'https://bpm.test:test:records').resolveReferences).toBe(
      false
    );
    expect(requested).toHaveLength(1);
    await client.close();
  });

  it('follows an empty native page when its continuation advances', async () => {
    const handler = tool({
      getRecords: async () => ({
        value: [],
        '@odata.nextLink': 'https://bpm.test/Contact?$skiptoken=next',
      }),
      getNextPage: async (_collection: string, link: string) => {
        expect(link).toBe('https://bpm.test/Contact?$skiptoken=next');
        return { value: [{ Id: 'after-empty-page' }] };
      },
      previewCollectionUrl: () => 'https://bpm.test/Contact?$skip=0',
    });
    const result = await handler({ collection: 'Contact', auto_paginate: true, max_records: 10 });
    expect(result.isError).not.toBe(true);
    expect(resultData(result).records).toEqual([{ Id: 'after-empty-page' }]);
    expect(resultData(result).has_more).toBe(false);
  });

  it('rejects a repeated continuation after an empty native page', async () => {
    const repeatedLink = 'https://bpm.test/Contact?$skip=0';
    const handler = tool({
      getRecords: async () => ({ value: [], '@odata.nextLink': repeatedLink }),
      getNextPage: async () => ({ value: [], '@odata.nextLink': repeatedLink }),
      previewCollectionUrl: () => repeatedLink,
    });
    const result = await handler({ collection: 'Contact', auto_paginate: true, max_records: 10 });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ success: false, code: 'odata_error' });
  });

  it('retains offsets for an initial skip and a nextLink skiptoken page', async () => {
    const rows = Array.from({ length: 8 }, (_, index) => ({ Id: `${index}`, Name: 'y'.repeat(10_000) }));
    let nextLink = '';
    const handler = tool({
      getRecords: async () => ({
        value: rows,
        '@odata.nextLink': 'https://bpm.test/Contact?$skiptoken=opaque',
      }),
      getNextPage: async (_collection: string, link: string) => {
        nextLink = link;
        return { value: rows, '@odata.nextLink': 'https://bpm.test/Contact?$skiptoken=next' };
      },
      previewCollectionUrl: (_collection: string, query: Record<string, unknown>) =>
        `https://bpm.test/Contact?$skip=${query.$skip}`,
    });
    const first = await handler({ collection: 'Contact', skip: 12, auto_paginate: true, max_records: 8 });
    const firstData = resultData(first);
    const firstState = decodeCursor(firstData.cursor as string, 'https://bpm.test:test:records');
    expect(new URL(firstState.nextLink!).searchParams.get('$skip')).toBe(
      String(12 + (firstData.count as number))
    );

    const skiptokenCursor = encodeCursor(
      {
        v: 1,
        collection: 'Contact',
        skip: 0,
        nextLink: 'https://bpm.test/Contact?$skiptoken=opaque#mcp-offset=4',
      },
      'https://bpm.test:test:records'
    );
    const secondHandler = tool({
      getNextPage: async (_collection: string, link: string) => {
        nextLink = link;
        return { value: rows, '@odata.nextLink': 'https://bpm.test/Contact?$skiptoken=next' };
      },
      previewCollectionUrl: () => 'https://bpm.test/Contact',
    });
    const second = await secondHandler({ cursor: skiptokenCursor, auto_paginate: true, max_records: 8 });
    expect(second.isError).not.toBe(true);
    expect(nextLink).toContain('#mcp-offset=4');
    const secondData = resultData(second);
    const secondState = decodeCursor(secondData.cursor as string, 'https://bpm.test:test:records');
    expect(new URL(secondState.nextLink!).hash).toBe(`#mcp-offset=${4 + (secondData.count as number)}`);
  });

  it('adds a clipped-row offset to an existing skiptoken page offset', () => {
    const continuation = continuationAfter('https://bpm.test/Contact?$skiptoken=opaque#mcp-offset=4', 3);
    expect(new URL(continuation).hash).toBe('#mcp-offset=7');
  });

  it('clips inside a later native token page and resumes without skipping rows', async () => {
    const http = new MockHttpClient();
    const secondPage = Array.from({ length: 6 }, (_, index) => ({
      Id: `large-${index}`,
      Name: 'w'.repeat(12_000),
    }));
    const thirdPage = [{ Id: 'page-three-1', Name: 'third page' }];
    http.setResponses([
      () => ({
        status: 200,
        data: {
          value: [
            { Id: 'small-1', Name: 'one' },
            { Id: 'small-2', Name: 'two' },
          ],
          '@odata.nextLink': 'https://bpm.test/odata/Contact?$skiptoken=page-two',
        },
      }),
      () => ({
        status: 200,
        data: {
          value: secondPage,
          '@odata.nextLink': 'https://bpm.test/odata/Contact?$skiptoken=page-three',
        },
      }),
      () => ({
        status: 200,
        data: {
          value: secondPage,
          '@odata.nextLink': 'https://bpm.test/odata/Contact?$skiptoken=page-three',
        },
      }),
      () => ({ status: 200, data: { value: thirdPage } }),
    ]);
    const client = new ODataClient(
      {
        bpmsoft_url: 'https://bpm.test',
        username: 'test',
        password: 'x',
        odata_version: 4,
        platform: 'net8',
        page_size: 100,
        max_batch_size: 100,
        lookup_cache_ttl: 300,
        request_timeout: 30_000,
        max_file_size: 1_000_000,
      } as BpmConfig,
      http as unknown as never
    );
    const handler = tool(client as unknown as Record<string, unknown>);

    const first = await handler({
      collection: 'Contact',
      select: 'Name',
      resolve_references: false,
      auto_paginate: true,
      max_records: 8,
    });
    const firstPayload = resultData(first);
    const returned = firstPayload.records as Array<{ Id: string }>;
    expect(returned.length).toBeGreaterThan(2);
    expect(returned.length).toBeLessThan(8);
    const firstState = decodeCursor(firstPayload.cursor as string, 'https://bpm.test:test:records');
    const resume = new URL(firstState.nextLink!);
    expect(resume.searchParams.get('$skiptoken')).toBe('page-two');
    expect(resume.hash).toBe(`#mcp-offset=${returned.length - 2}`);

    const second = await handler({
      cursor: firstPayload.cursor,
      resolve_references: false,
      auto_paginate: true,
      max_records: 8,
    });
    expect(second.isError).not.toBe(true);
    const secondRows = resultData(second).records as Array<{ Id: string }>;
    expect(secondRows[0].Id).toBe(secondPage[returned.length - 2].Id);
    expect(secondRows.some((row) => returned.some((previous) => previous.Id === row.Id))).toBe(false);
    expect(http.requests[2].url).toBe('https://bpm.test/odata/Contact?$skiptoken=page-two');
  });

  it('keeps ordinary reads on their existing refusal path and rejects an oversized row', async () => {
    const handler = tool({
      getRecords: async () => ({ value: [{ Id: ID, Name: 'z'.repeat(600_000) }] }),
      previewCollectionUrl: () => 'https://bpm.test/Contact',
    });
    expect((await handler({ collection: 'Contact', top: 1 })).isError).toBe(true);
    const auto = await handler({ collection: 'Contact', auto_paginate: true, max_records: 1 });
    expect(auto.isError).toBe(true);
  });
});
