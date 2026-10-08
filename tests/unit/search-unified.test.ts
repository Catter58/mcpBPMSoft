import { describe, it, expect, vi } from 'vitest';
import { registerSearchUnifiedTool } from '../../src/workflows/search-unified.js';
import type { ServiceContainer } from '../../src/tools/init-tool.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { BpmApiError } from '../../src/utils/errors.js';
import { decodeCursor } from '../../src/utils/cursor.js';

function setup() {
  const getRecords = vi.fn(async (_collection: string, _query: Record<string, unknown>) => ({
    value: [{ Id: 'id-1', Name: 'АО «ЛАНИТ»' }],
    '@odata.count': 1,
  }));
  const getCount = vi.fn(async () => 1);
  const getEntityMetadata = vi.fn(async (collection: string) => ({
    collectionName: collection,
    properties: [
      { name: 'Id', type: 'Edm.Guid', nullable: false, isLookup: false },
      {
        name: collection === 'Activity' ? 'Title' : 'Name',
        caption: 'Название',
        type: 'Edm.String',
        nullable: false,
        isLookup: false,
      },
    ],
  }));
  const services = {
    initialized: true,
    config: { bpmsoft_url: 'https://crm.example.test', username: 'test-user', odata_version: 4 },
    authManager: { ensureAuthenticated: vi.fn(async () => undefined) },
    odataClient: { getRecords, getCount },
    metadataManager: {
      resolveCollectionReference: vi.fn(async (name: string) => ({ name })),
      getEntityMetadata,
      resolveFieldReference: vi.fn(async (collection: string, input: string) => {
        const properties = (await getEntityMetadata(collection)).properties;
        const property = properties.find(
          (candidate) => candidate.name === input || candidate.caption === input
        );
        return property ? { name: property.name } : { name: null };
      }),
      getLookupInfo: vi.fn(async () => null),
    },
  } as unknown as ServiceContainer;
  let handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
  registerSearchUnifiedTool(
    {
      registerTool: (_name: string, _meta: unknown, fn: typeof handler) => {
        handler = fn;
      },
    } as never,
    services
  );
  return {
    getRecords,
    getCount,
    getEntityMetadata,
    services,
    call: (args: Record<string, unknown>) => handler(args),
  };
}

describe('registered unified search', () => {
  it('compiles normalized search and returns a captioned card', async () => {
    const env = setup();
    const result = await env.call({ query: 'Ланит', collections: ['Account'] });
    expect(env.getRecords.mock.calls[0][1].$filter).toBe("(contains(tolower(Name), 'ланит'))");
    expect(result.structuredContent).toMatchObject({
      total_found: 1,
      count: 1,
      complete: true,
      results: [{ id: 'id-1', match_type: 'contains', display_record: { Название: 'АО «ЛАНИТ»' } }],
    });
  });
  it('retries by core name only after a successful empty search', async () => {
    const env = setup();
    env.getRecords.mockResolvedValueOnce({ value: [], '@odata.count': 0 });
    const result = await env.call({ query: 'АО ЛАНИТ', collections: ['Account'] });
    expect(env.getRecords.mock.calls.map((call) => call[1].$filter)).toEqual([
      "(contains(tolower(Name), 'ао ланит'))",
      "(contains(tolower(Name), 'ланит'))",
    ]);
    expect(result.structuredContent?.results).toEqual([expect.objectContaining({ match_type: 'core' })]);
  });
  it('separates shown count from true totals and keeps a usable continuation', async () => {
    const env = setup();
    env.getRecords.mockResolvedValue({ value: [{ Id: 'id-1', Name: 'Example' }], '@odata.count': 17 });
    const result = await env.call({ query: 'Example', collections: ['Account'], top: 1 });
    expect(result.structuredContent).toMatchObject({
      count: 1,
      total_found: 17,
      has_more: true,
      complete: false,
      counts_by_collection: { Account: 17 },
    });
    const cursor = (result.structuredContent?.cursors_by_collection as Record<string, string>).Account;
    expect(decodeCursor(cursor, 'https://crm.example.test:test-user:records')).toMatchObject({
      collection: 'Account',
      skip: 1,
      top: 1,
    });
  });
  it.each([400, 403])('preserves unrelated HTTP %i errors without fallback or false zero', async (status) => {
    const env = setup();
    env.getRecords.mockRejectedValue(new BpmApiError('Query rejected', status));
    const result = await env.call({ query: 'Example', collections: ['Account'] });
    expect(env.getRecords).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      total_found: null,
      complete: false,
      counts_by_collection: { Account: null },
      skipped: ['Account'],
    });
    expect(result.structuredContent?.errors).toEqual([
      expect.objectContaining({ code: status === 403 ? 'auth_required' : 'validation' }),
    ]);
  });
  it('uses Title for Activity and does not lose fetched rows to a global cap', async () => {
    const env = setup();
    env.getRecords.mockResolvedValue({
      value: Array.from({ length: 50 }, (_, index) => ({
        Id: `id-${index}`,
        Name: `Name ${index}`,
        Title: `Title ${index}`,
      })),
      '@odata.count': 50,
    } as never);
    const result = await env.call({
      query: 'Title',
      collections: ['Account', 'Contact', 'Activity'],
      top: 50,
    });
    expect(result.structuredContent).toMatchObject({
      count: 150,
      total_found: 150,
      has_more: false,
      complete: true,
    });
    expect(env.getRecords.mock.calls[2][1].$filter).toBe("(contains(tolower(Title), 'title'))");
  });

  it('searches explicit string fields with OR, reports matched fields, and deduplicates repeated IDs', async () => {
    const env = setup();
    env.getEntityMetadata.mockImplementation(
      async () =>
        ({
          collectionName: 'Account',
          properties: [
            { name: 'Id', type: 'Edm.Guid', nullable: false, isLookup: false },
            { name: 'Name', caption: 'Название', type: 'Edm.String', nullable: false, isLookup: false },
            { name: 'TaxCode', caption: 'ИНН', type: 'Edm.String', nullable: true, isLookup: false },
          ],
        }) as never
    );
    env.getRecords.mockResolvedValue({
      value: [
        { Id: 'id-1', Name: 'ООО Ланит', TaxCode: '770123' },
        { Id: 'id-1', Name: 'ООО Ланит', TaxCode: '770123' },
      ],
      '@odata.count': 2,
    });
    const result = await env.call({
      query: '770',
      fields_by_collection: { Account: ['ИНН', 'Name'] },
    });
    expect(env.getRecords.mock.calls[0][1].$filter).toContain(' or ');
    expect(result.structuredContent).toMatchObject({
      count: 1,
      results: [{ id: 'id-1', matched_fields: ['TaxCode'] }],
      count_semantics: expect.stringContaining('уникальные пары'),
    });
  });

  it('supports exact field matching and does not broaden explicit searches to core fallback', async () => {
    const env = setup();
    env.getRecords.mockResolvedValueOnce({ value: [], '@odata.count': 0 });
    const result = await env.call({
      query: 'АО ЛАНИТ',
      fields_by_collection: { Account: ['Name'] },
      match_mode: 'exact',
    });
    expect(env.getRecords).toHaveBeenCalledTimes(1);
    expect(env.getRecords.mock.calls[0][1].$filter).toContain(" eq 'ао ланит'");
    expect(result.structuredContent).toMatchObject({ total_found: 0, complete: true, results: [] });
  });

  it('rejects unknown/non-string fields and incomplete or unused field mappings', async () => {
    const env = setup();
    const missing = await env.call({
      query: 'x',
      collections: ['Account', 'Contact'],
      fields_by_collection: { Account: ['Name'] },
    });
    expect(missing.isError).toBe(true);
    const extra = await env.call({
      query: 'x',
      collections: ['Account'],
      fields_by_collection: { Contact: ['Name'] },
    });
    expect(extra.isError).toBe(true);
    env.getEntityMetadata.mockImplementation(
      async () =>
        ({
          collectionName: 'Account',
          properties: [
            { name: 'Id', type: 'Edm.Guid', nullable: false, isLookup: false },
            { name: 'Name', type: 'Edm.String', nullable: false, isLookup: false },
            { name: 'Code', type: 'Edm.Int32', nullable: false, isLookup: false },
          ],
        }) as never
    );
    const invalid = await env.call({ query: 'x', fields_by_collection: { Account: ['Missing'] } });
    expect(invalid.isError).toBe(true);
    const nonString = await env.call({ query: 'x', fields_by_collection: { Account: ['Code'] } });
    expect(nonString.isError).toBe(true);
  });

  it('ошибка коллекции → isError true', async () => {
    const env = setup();
    env.getRecords.mockRejectedValue(new Error('boom'));
    const result = await env.call({ query: 'ланит', collections: ['Account'] });
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.errors).toEqual([
      expect.objectContaining({ collection: 'Account', message: 'boom' }),
    ]);
  });

  it('ничего не найдено во всех коллекциях → isError false', async () => {
    const env = setup();
    env.getRecords.mockResolvedValue({ value: [], '@odata.count': 0 });
    env.getCount.mockResolvedValue(0);
    const result = await env.call({ query: 'нетничего' });
    expect(result.isError).toBe(false);
    expect(result.structuredContent?.total_found).toBe(0);
  });
});
