/**
 * Unit tests for bpm_describe_instance tool.
 *
 * Stubs ServiceContainer (metadataManager / odataClient / authManager) and
 * captures the handler from `server.registerTool` to call it directly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerDescribeInstanceTool } from '../../src/tools/describe-instance-tool.js';
import type { ServiceContainer } from '../../src/tools/init-tool.js';
import type { EntityMetadata, EntityProperty } from '../../src/types/index.js';

interface FakeServer {
  registerTool: ReturnType<typeof vi.fn>;
}

function buildContactMeta(): EntityMetadata {
  const properties: EntityProperty[] = [
    { name: 'Id', type: 'Edm.Guid', nullable: false, isLookup: false },
    { name: 'Name', type: 'Edm.String', nullable: false, isLookup: false },
    {
      name: 'AccountId',
      type: 'Edm.Guid',
      nullable: true,
      isLookup: true,
      lookupCollection: 'Account',
      lookupDisplayColumn: 'Name',
    },
    { name: 'UsrCustomNote', type: 'Edm.String', nullable: true, isLookup: false },
    { name: 'UsrLevel', type: 'Edm.Int32', nullable: true, isLookup: false },
  ];
  return {
    name: 'Contact',
    collectionName: 'Contact',
    properties,
    lookupFields: ['AccountId'],
    cachedAt: Date.now(),
  };
}

function buildAccountMeta(): EntityMetadata {
  const properties: EntityProperty[] = [
    { name: 'Id', type: 'Edm.Guid', nullable: false, isLookup: false },
    { name: 'Name', type: 'Edm.String', nullable: false, isLookup: false },
  ];
  return {
    name: 'Account',
    collectionName: 'Account',
    properties,
    lookupFields: [],
    cachedAt: Date.now(),
  };
}

interface BuildOpts {
  countFails?: Set<string>;
}

function buildServices(opts: BuildOpts = {}): {
  services: ServiceContainer;
  getEntitySets: ReturnType<typeof vi.fn>;
  getEntityMetadata: ReturnType<typeof vi.fn>;
  getCount: ReturnType<typeof vi.fn>;
} {
  const getEntitySets = vi.fn(async () => [
    { name: 'Contact', entityType: 'BPMSoft.Contact' },
    { name: 'Account', entityType: 'BPMSoft.Account' },
    { name: 'UsrCustomThing', entityType: 'BPMSoft.UsrCustomThing' },
    { name: 'SysSettings', entityType: 'BPMSoft.SysSettings' },
  ]);

  const getEntityMetadata = vi.fn(async (name: string) => {
    if (name === 'Contact') return buildContactMeta();
    if (name === 'Account') return buildAccountMeta();
    throw new Error(`unexpected: ${name}`);
  });

  const failSet = opts.countFails ?? new Set<string>();
  const getCount = vi.fn(async (collection: string) => {
    if (failSet.has(collection)) {
      throw new Error(`count failed for ${collection}`);
    }
    if (collection === 'Contact') return 42;
    if (collection === 'Account') return 7;
    return 0;
  });

  const services = {
    initialized: true,
    config: {} as never,
    httpClient: {} as never,
    authManager: { ensureAuthenticated: vi.fn(async () => undefined) } as never,
    odataClient: { getCount } as never,
    metadataManager: {
      getEntitySets,
      getEntityMetadata,
    } as never,
    lookupResolver: {} as never,
  } as ServiceContainer;

  return { services, getEntitySets, getEntityMetadata, getCount };
}

function buildServer(): {
  server: FakeServer;
  getHandler: () => (args: Record<string, unknown>) => Promise<unknown>;
} {
  const server: FakeServer = { registerTool: vi.fn() };
  return {
    server,
    getHandler: () =>
      server.registerTool.mock.calls[0][2] as (args: Record<string, unknown>) => Promise<unknown>,
  };
}

describe('bpm_describe_instance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('возвращает корректную сводку с основными сущностями и Usr*-коллекциями', async () => {
    const { services } = buildServices();
    const { server, getHandler } = buildServer();

    registerDescribeInstanceTool(server as never, services);
    const handler = getHandler();
    const result = (await handler({})) as {
      content: Array<{ type: string; text: string }>;
      structuredContent: {
        collections_total: number;
        custom_collections_total: number;
        custom_collections_sample: string[];
        main_entities: Array<{
          name: string;
          total_fields: number;
          lookup_fields: number;
          custom_fields_count: number;
          custom_fields_sample: string[];
          record_count: number | null;
        }>;
        from_cache: boolean;
      };
    };

    expect(result.structuredContent.collections_total).toBe(4);
    expect(result.structuredContent.custom_collections_total).toBe(1);
    expect(result.structuredContent.custom_collections_sample).toEqual(['UsrCustomThing']);
    expect(result.structuredContent.from_cache).toBe(false);

    const main = result.structuredContent.main_entities;
    expect(main.map((m) => m.name)).toEqual(['Contact', 'Account']);

    const contact = main.find((m) => m.name === 'Contact')!;
    expect(contact.total_fields).toBe(5);
    expect(contact.lookup_fields).toBe(1);
    expect(contact.custom_fields_count).toBe(2);
    expect(contact.custom_fields_sample).toEqual(['UsrCustomNote', 'UsrLevel']);
    expect(contact.record_count).toBe(42);

    const account = main.find((m) => m.name === 'Account')!;
    expect(account.record_count).toBe(7);
    expect(account.custom_fields_count).toBe(0);

    const text = result.content[0].text;
    expect(text).toContain('Инстанс');
    expect(text).toContain('Основные сущности');
    expect(text).toContain('Кастомные коллекции');
    expect(text).toContain('UsrCustomThing');
  });

  it('кеширует результат на 5 минут — повторный вызов не дёргает getEntitySets', async () => {
    const { services, getEntitySets, getEntityMetadata, getCount } = buildServices();
    const { server, getHandler } = buildServer();
    registerDescribeInstanceTool(server as never, services);
    const handler = getHandler();

    const first = (await handler({})) as { structuredContent: { from_cache: boolean } };
    expect(first.structuredContent.from_cache).toBe(false);
    expect(getEntitySets).toHaveBeenCalledTimes(1);
    expect(getEntityMetadata).toHaveBeenCalledTimes(2);
    expect(getCount).toHaveBeenCalledTimes(2);

    const second = (await handler({})) as { structuredContent: { from_cache: boolean } };
    expect(second.structuredContent.from_cache).toBe(true);
    // Никакого нового сетевого/метадатного дёрганья.
    expect(getEntitySets).toHaveBeenCalledTimes(1);
    expect(getEntityMetadata).toHaveBeenCalledTimes(2);
    expect(getCount).toHaveBeenCalledTimes(2);
  });

  it('если getCount падает — record_count=null, остальной вызов не падает', async () => {
    const { services } = buildServices({ countFails: new Set(['Contact']) });
    const { server, getHandler } = buildServer();
    registerDescribeInstanceTool(server as never, services);
    const handler = getHandler();

    const result = (await handler({})) as {
      content: Array<{ type: string; text: string }>;
      structuredContent: {
        main_entities: Array<{ name: string; record_count: number | null }>;
      };
      isError?: boolean;
    };

    expect(result.isError).toBeFalsy();
    const contact = result.structuredContent.main_entities.find((m) => m.name === 'Contact')!;
    expect(contact.record_count).toBeNull();
    const account = result.structuredContent.main_entities.find((m) => m.name === 'Account')!;
    expect(account.record_count).toBe(7);
    expect(result.content[0].text).toContain('count: n/a');
  });
});
