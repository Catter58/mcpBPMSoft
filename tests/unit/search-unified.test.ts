/**
 * Unit tests for bpm_search_unified fuzzy fallback and pagination contract.
 */

import { describe, it, expect } from 'vitest';
import { registerSearchUnifiedTool } from '../../src/workflows/search-unified.js';
import type { ServiceContainer } from '../../src/tools/init-tool.js';
import type { BpmConfig } from '../../src/types/index.js';

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface RegisteredTool {
  name: string;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

function buildFakeServer(): {
  registered: RegisteredTool[];
  registerTool: (n: string, m: unknown, h: RegisteredTool['handler']) => void;
} {
  const registered: RegisteredTool[] = [];
  return {
    registered,
    registerTool(name, _meta, handler) {
      registered.push({ name, handler });
    },
  };
}

function makeCfg(): BpmConfig {
  return {
    bpmsoft_url: 'https://bpm.test',
    odata_version: 4,
    platform: 'net8',
    page_size: 100,
    max_batch_size: 100,
    lookup_cache_ttl: 300,
    request_timeout: 30000,
    max_file_size: 10 * 1024 * 1024,
  };
}

function buildServices(
  filters: string[],
  responder: (filter: string) => Array<Record<string, unknown>>
): ServiceContainer {
  return {
    config: makeCfg(),
    httpClient: null!,
    authManager: { async ensureAuthenticated() {} } as never,
    metadataManager: {
      async getEntitySets() {
        return [
          { name: 'Contact', entityType: 'Contact' },
          { name: 'Account', entityType: 'Account' },
        ];
      },
    } as never,
    odataClient: {
      async getRecords(_coll: string, query?: { $filter?: string }) {
        const f = String(query?.$filter ?? '');
        filters.push(f);
        return { value: responder(f) };
      },
    } as never,
    lookupResolver: null!,
    processEngine: null!,
    initialized: true,
  };
}

async function run(services: ServiceContainer, args: Record<string, unknown>): Promise<ToolResult> {
  const server = buildFakeServer();
  registerSearchUnifiedTool(server as never, services);
  return server.registered[0].handler(args);
}

describe('bpm_search_unified', () => {
  it('ищет case-insensitive по нормализованной строке', async () => {
    const filters: string[] = [];
    const services = buildServices(filters, (f) =>
      f === "contains(tolower(Name), 'ланит')" ? [{ Id: 'id-1', Name: 'АО «ЛАНИТ»' }] : []
    );
    const result = await run(services, { query: 'Ланит', collections: ['Account'] });
    const sc = result.structuredContent as Record<string, unknown>;
    expect((sc.results as Array<{ id: string; match_type: string }>)[0]).toMatchObject({
      id: 'id-1',
      match_type: 'contains',
    });
  });

  it('фолбэк на ядро имени: «АО ЛАНИТ» находит по «ланит»', async () => {
    const filters: string[] = [];
    const services = buildServices(filters, (f) => {
      if (f.includes("'ао ланит'")) return [];
      if (f.includes("'ланит'")) return [{ Id: 'id-1', Name: 'АО «ЛАНИТ»' }];
      return [];
    });
    const result = await run(services, { query: 'АО ЛАНИТ', collections: ['Account'] });
    const sc = result.structuredContent as Record<string, unknown>;
    const hits = sc.results as Array<{ id: string; match_type: string }>;
    expect(hits).toHaveLength(1);
    expect(hits[0].match_type).toBe('core');
    expect(sc.count).toBe(1);
    expect(sc.total_found).toBe(1);
    expect(sc.has_more).toBe(false);
  });

  it('tolower-отказ (400) → ретрай case-sensitive', async () => {
    const filters: string[] = [];
    const services = buildServices(filters, (f) => {
      if (f.includes('tolower')) {
        const err = new Error('invalid query') as Error & { httpStatus: number };
        err.httpStatus = 400;
        throw err;
      }
      return f.includes('contains(Name') ? [{ Id: 'id-1', Name: 'ланит' }] : [];
    });
    const result = await run(services, { query: 'ланит', collections: ['Account'] });
    const sc = result.structuredContent as Record<string, unknown>;
    expect((sc.results as unknown[]).length).toBe(1);
    expect(filters.filter((f) => f.includes('tolower'))).toHaveLength(1);
  });
});
