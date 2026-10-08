import { describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ServiceContainer } from '../../src/tools/init-tool.js';
import type { EntityMetadata, EntityProperty } from '../../src/types/index.js';
import { prepareUpdateIntent } from '../../src/workflows/update-preparation.js';
import { registerWriteTools } from '../../src/tools/write-tools.js';

const ID = 'aaaaaaaa-1111-4111-8111-111111111111';
function prop(name: string, type: string): EntityProperty {
  return { name, type, nullable: true, isLookup: false };
}
function makeServices(record: Record<string, unknown>) {
  const metadata: EntityMetadata = {
    name: 'Target',
    collectionName: 'Target',
    cachedAt: 0,
    lookupFields: [],
    properties: [
      prop('Id', 'Edm.Guid'),
      prop('Amount', 'Edm.Decimal'),
      prop('Count', 'Edm.Int32'),
      prop('Big', 'Edm.Int64'),
      prop('Start', 'Edm.DateTimeOffset'),
      prop('End', 'Edm.DateTimeOffset'),
      prop('OnlyDate', 'Edm.Date'),
      prop('Name', 'Edm.String'),
    ],
  };
  const getRecord = vi.fn(async () => record);
  const updateRecord = vi.fn(async () => undefined);
  const services = {
    metadataManager: {
      resolveCollectionReference: vi.fn(async (name: string) => ({ name })),
      getEntityMetadata: vi.fn(async () => metadata),
      resolveFieldReference: vi.fn(async (_collection: string, name: string) => ({ name })),
    },
    odataClient: { getRecord, updateRecord },
    lookupResolver: {
      resolveDataLookups: vi.fn(async (_collection: string, data: Record<string, unknown>) => ({
        data,
        notes: [],
        coerced: [],
      })),
      createResolutionContext: () => ({
        now: new Date('2026-10-07T12:00:00.000Z'),
        getCurrentUser: async () => ({ userId: ID, timeZoneId: 'Europe/Moscow' }),
        getTimeZone: async () => ({ timeZone: 'Europe/Moscow', source: 'profile' as const }),
      }),
    },
  } as unknown as ServiceContainer;
  return { services, getRecord, updateRecord };
}

describe('prepareUpdateIntent', () => {
  it('normalizes typed relative operations to one absolute patch using one snapshot', async () => {
    const { services, getRecord } = makeServices({
      Id: ID,
      Amount: '10.25',
      Count: 4,
      Name: '',
      '@odata.etag': 'W/"7"',
    });
    const prepared = await prepareUpdateIntent(services, 'Target', ID, {}, [
      { field: 'Amount', op: 'percent_change', amount: '10' },
      { field: 'Count', op: 'increment', amount: 2 },
      { field: 'Name', op: 'set_if_empty', value: 'Ready' },
    ]);
    expect(prepared.data).toEqual({ Amount: '11.275', Count: 6, Name: 'Ready' });
    expect(prepared.before).toEqual({ Amount: '10.25', Count: 4, Name: '' });
    expect(prepared.after).toEqual({ Amount: '11.275', Count: 6, Name: 'Ready' });
    expect(prepared.concurrency_protection).toBe('etag');
    expect(getRecord).toHaveBeenCalledTimes(1);
  });

  it('keeps large Int64, decimal operands, and calendar-only Edm.Date exact', async () => {
    const { services } = makeServices({
      Id: ID,
      Amount: '0.10',
      Big: '9007199254740993',
      OnlyDate: '2026-01-31',
    });
    const prepared = await prepareUpdateIntent(services, 'Target', ID, {}, [
      { field: 'Amount', op: 'add', amount: '0.20' },
      { field: 'Big', op: 'increment', amount: '2' },
      { field: 'OnlyDate', op: 'shift_date', amount: 1, unit: 'calendar_days' },
    ]);
    expect(prepared.data).toEqual({ Amount: '0.3', Big: '9007199254740995', OnlyDate: '2026-02-01' });
    const invalid = await prepareUpdateIntent(services, 'Target', ID, {}, [
      { field: 'OnlyDate', op: 'shift_date', amount: 24, unit: 'hours' },
    ]);
    expect(invalid.blockers[0]?.message).toMatch(/Edm.Date/);
  });

  it('blocks duplicate operation/data fields and immutable IDs before lookup or write', async () => {
    const { services } = makeServices({ Id: ID, Amount: '10' });
    const conflict = await prepareUpdateIntent(services, 'Target', ID, { Amount: '12' }, [
      { field: 'Amount', op: 'increment', amount: 1 },
    ]);
    expect(conflict.blockers[0]?.message).toMatch(/одновременно/);
    const immutable = await prepareUpdateIntent(services, 'Target', ID, {}, [
      { field: 'Id', op: 'set_if_empty', value: 'other' },
    ]);
    expect(immutable.blockers[0]?.message).toMatch(/UUID/);
  });

  it('collects independent blockers and reports set_if_empty as a no-op when already set', async () => {
    const { services } = makeServices({ Id: ID, Amount: '10', Count: 2, Name: 'Already set' });
    const blocked = await prepareUpdateIntent(services, 'Target', ID, {}, [
      { field: 'Missing', op: 'increment', amount: 1 },
      { field: 'Count', op: 'shift_date', amount: 1, unit: 'calendar_days' },
    ]);
    expect(blocked.blockers.length).toBeGreaterThanOrEqual(2);
    const unchanged = await prepareUpdateIntent(services, 'Target', ID, {}, [
      { field: 'Name', op: 'set_if_empty', value: 'Replacement' },
    ]);
    expect(unchanged.no_changes).toBe(true);
    expect(unchanged.data).toEqual({});
  });

  it('collects timezone blockers for every calendar operation when no valid zone is available', async () => {
    const { services } = makeServices({
      Id: ID,
      Start: '2026-03-07T08:30:00Z',
      End: '2026-03-07T09:30:00Z',
    });
    services.lookupResolver.createResolutionContext = () =>
      ({
        now: new Date(),
        getCurrentUser: async () => ({ userId: ID }),
        getTimeZone: async () => {
          throw new Error('timezone unavailable');
        },
      }) as never;
    const prepared = await prepareUpdateIntent(services, 'Target', ID, {}, [
      { field: 'Start', op: 'shift_date', amount: 1, unit: 'calendar_days' },
      { field: 'End', op: 'shift_date', amount: 1, unit: 'calendar_days' },
    ]);
    expect(prepared.blockers.map((blocker) => blocker.field)).toEqual(['Start', 'End']);
  });

  it('distinguishes elapsed hours and calendar days and rejects a DST gap', async () => {
    const { services } = makeServices({ Id: ID, Start: '2026-03-07T08:30:45.123Z' });
    services.lookupResolver.createResolutionContext = () =>
      ({
        now: new Date(),
        getCurrentUser: async () => ({ userId: ID }),
        getTimeZone: async () => ({ timeZone: 'America/New_York', source: 'profile' as const }),
      }) as never;
    const hours = await prepareUpdateIntent(services, 'Target', ID, {}, [
      { field: 'Start', op: 'shift_date', amount: 24, unit: 'hours' },
    ]);
    const days = await prepareUpdateIntent(services, 'Target', ID, {}, [
      { field: 'Start', op: 'shift_date', amount: 1, unit: 'calendar_days' },
    ]);
    expect(hours.data.Start).toBe('2026-03-08T08:30:45.123Z');
    expect(days.data.Start).toBe('2026-03-08T07:30:45.123Z');
    const gap = makeServices({ Id: ID, Start: '2026-03-07T07:30:00.000Z' });
    gap.services.lookupResolver.createResolutionContext = services.lookupResolver.createResolutionContext;
    const blocked = await prepareUpdateIntent(gap.services, 'Target', ID, {}, [
      { field: 'Start', op: 'shift_date', amount: 1, unit: 'calendar_days' },
    ]);
    expect(blocked.blockers[0]?.message).toMatch(/не существует/);
  });

  it('returns the blocked update through the real MCP output schema', async () => {
    const { services, updateRecord } = makeServices({
      Id: ID,
      Amount: '10',
      Name: 'Existing',
      '@odata.etag': 'W/"7"',
    });
    Object.assign(services, { initialized: true, authManager: { ensureAuthenticated: vi.fn() } });
    const server = new McpServer({ name: 'update-contract', version: '0.0.0' });
    registerWriteTools(server, services);
    const client = new Client({ name: 'update-contract-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({
        name: 'bpm_update_record',
        arguments: {
          collection: 'Target',
          id: ID,
          data: {},
          operations: [{ field: 'Amount', op: 'shift_date', amount: 1, unit: 'calendar_days' }],
        },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        ready: false,
        updated_fields: [],
        blockers: [{ field: 'Amount' }],
      });
      expect(result.structuredContent).toHaveProperty('normalized_args.data');
      const noOp = await client.callTool({
        name: 'bpm_update_record',
        arguments: {
          collection: 'Target',
          id: ID,
          operations: [{ field: 'Name', op: 'set_if_empty', value: 'replacement' }],
        },
      });
      expect(noOp.isError).toBeFalsy();
      expect(noOp.structuredContent).toMatchObject({ ready: true, no_changes: true, updated_fields: [] });
      expect(updateRecord).not.toHaveBeenCalled();
      const stale = await client.callTool({
        name: 'bpm_update_record',
        arguments: {
          collection: 'Target',
          id: ID,
          data: { Name: 'Changed' },
          dry_run: true,
          expected_etag: 'W/"6"',
        },
      });
      expect(stale.isError).toBeFalsy();
      expect(stale.structuredContent).toMatchObject({
        ready: false,
        blockers: [{ code: 'concurrency_conflict' }],
      });
      expect(updateRecord).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('blocks an explicit ETag during dry-run when the single snapshot has no ETag', async () => {
    const { services, updateRecord } = makeServices({ Id: ID, Amount: '10', Name: 'Existing' });
    Object.assign(services, { initialized: true, authManager: { ensureAuthenticated: vi.fn() } });
    const server = new McpServer({ name: 'update-etag-contract', version: '0.0.0' });
    registerWriteTools(server, services);
    const client = new Client({ name: 'update-etag-contract-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const malformed = await client.callTool({
        name: 'bpm_update_record',
        arguments: {
          collection: 'Target',
          id: ID,
          data: { Name: 'Changed' },
          dry_run: true,
          expected_etag: 'not-an-etag',
        },
      });
      expect(malformed.structuredContent).toMatchObject({
        ready: false,
        blockers: [{ code: 'invalid_expected_etag' }],
      });
      const result = await client.callTool({
        name: 'bpm_update_record',
        arguments: {
          collection: 'Target',
          id: ID,
          data: { Name: 'Changed' },
          dry_run: true,
          expected_etag: 'W/"7"',
        },
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        ready: false,
        blockers: [{ code: 'concurrency_unsupported' }],
      });
      const snapshotOnly = await client.callTool({
        name: 'bpm_update_record',
        arguments: { collection: 'Target', id: ID, data: { Name: 'Changed' }, dry_run: true },
      });
      expect(snapshotOnly.structuredContent).toMatchObject({
        ready: true,
        concurrency_protection: 'snapshot_only',
      });
      expect(snapshotOnly.structuredContent).not.toHaveProperty('normalized_args.expected_etag');
      expect(updateRecord).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
