import { describe, it, expect } from 'vitest';
import { LookupResolver } from '../../src/lookup/lookup-resolver.js';
import { BpmApiError } from '../../src/utils/errors.js';
import type { BpmConfig, ODataCollectionResponse } from '../../src/types/index.js';

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

interface StubODataClient {
  getRecords: (
    collection: string,
    query?: { $filter?: string; $select?: string; $top?: number }
  ) => Promise<ODataCollectionResponse<Record<string, unknown>>>;
  calls: Array<{ collection: string; filter?: string; top?: number }>;
}

function makeStubODataClient(
  responder: (filter: string) => Array<Record<string, unknown>>
): StubODataClient {
  const calls: Array<{ collection: string; filter?: string; top?: number }> = [];
  return {
    calls,
    async getRecords(collection, query) {
      calls.push({ collection, filter: query?.$filter, top: query?.$top });
      return { value: responder(String(query?.$filter ?? '')) };
    },
  };
}

describe('LookupResolver fuzzy cascade', () => {
  it('этап 1: точный eq без fuzzy-пометки, matchType=exact', async () => {
    const od = makeStubODataClient((f) =>
      f.includes("eq 'АО «ЛАНИТ»'") ? [{ Id: 'id-1', Name: 'АО «ЛАНИТ»' }] : []
    );
    const resolver = new LookupResolver(makeCfg(), od as never, {} as never);
    const r = await resolver.resolve('Account', 'АО «ЛАНИТ»', 'Name', { fuzzy: true });
    expect(r.resolved).toBe(true);
    expect(r.fuzzy).toBeUndefined();
    expect(r.matchType).toBe('exact');
    expect(od.calls).toHaveLength(1);
  });

  it('этап 3: «Ланит» находит «АО «ЛАНИТ»» через core-contains', async () => {
    const od = makeStubODataClient((f) =>
      f.includes('tolower') && f.includes("'ланит'") ? [{ Id: 'id-1', Name: 'АО «ЛАНИТ»' }] : []
    );
    const resolver = new LookupResolver(makeCfg(), od as never, {} as never);
    const r = await resolver.resolve('Account', 'Ланит', 'Name', { fuzzy: true });
    expect(r.resolved).toBe(true);
    expect(r.id).toBe('id-1');
    expect(r.fuzzy).toBe(true);
    expect(r.matchedValue).toBe('АО «ЛАНИТ»');
    expect(['contains', 'core']).toContain(r.matchType);
  });

  it('этап 3 срабатывает когда contains полной строки пуст, а ядро находит', async () => {
    const od = makeStubODataClient((f) => {
      if (f.includes("'ао ланит'")) return [];
      if (f.includes("'ланит'")) return [{ Id: 'id-1', Name: 'АО «ЛАНИТ»' }];
      return [];
    });
    const resolver = new LookupResolver(makeCfg(), od as never, {} as never);
    const r = await resolver.resolve('Account', 'АО ЛАНИТ', 'Name', { fuzzy: true });
    expect(r.resolved).toBe(true);
    expect(r.matchType).toBe('core');
    expect(r.matchedValue).toBe('АО «ЛАНИТ»');
  });

  it('неоднозначность: два core-точных кандидата → resolved=false, ранжированы со score', async () => {
    const od = makeStubODataClient((f) =>
      f.includes("'ланит'")
        ? [
            { Id: 'b', Name: 'ЗАО ЛАНИТ' },
            { Id: 'a', Name: 'АО «ЛАНИТ»' },
          ]
        : []
    );
    const resolver = new LookupResolver(makeCfg(), od as never, {} as never);
    const r = await resolver.resolve('Account', 'Ланит', 'Name', { fuzzy: true });
    expect(r.resolved).toBe(false);
    expect(r.candidates).toHaveLength(2);
    expect(r.candidates[0].score).toBe(90);
    expect(r.candidates[1].score).toBe(90);
  });

  it('уверенный лидер при отрыве ≥ 15: core-exact бьёт prefix', async () => {
    const od = makeStubODataClient((f) =>
      f.includes("'ланит'")
        ? [
            { Id: 'b', Name: 'Ланит-Интеграция' },
            { Id: 'a', Name: 'АО «ЛАНИТ»' },
          ]
        : []
    );
    const resolver = new LookupResolver(makeCfg(), od as never, {} as never);
    const r = await resolver.resolve('Account', 'Ланит', 'Name', { fuzzy: true });
    expect(r.resolved).toBe(true);
    expect(r.id).toBe('a');
    expect(r.matchedValue).toBe('АО «ЛАНИТ»');
  });

  it('fuzzy=false ограничивается точным eq', async () => {
    const od = makeStubODataClient(() => []);
    const resolver = new LookupResolver(makeCfg(), od as never, {} as never);
    const r = await resolver.resolve('Account', 'Ланит', 'Name', { fuzzy: false });
    expect(r.resolved).toBe(false);
    expect(od.calls).toHaveLength(1);
  });

  it('v3: contains-этапы используют substringof', async () => {
    const od = makeStubODataClient((f) =>
      f.includes('substringof') ? [{ Id: 'id-1', Name: 'АО «ЛАНИТ»' }] : []
    );
    const resolver = new LookupResolver(makeCfg({ odata_version: 3 }), od as never, {} as never);
    const r = await resolver.resolve('Account', 'Ланит', 'Name', { fuzzy: true });
    expect(r.resolved).toBe(true);
    expect(r.fuzzy).toBe(true);
  });

  it('tolower-отказ: 400 на CI-фильтре → ретрай без tolower, флаг залипает', async () => {
    const calls: string[] = [];
    const od = {
      calls,
      async getRecords(_collection: string, query?: { $filter?: string }) {
        const f = String(query?.$filter ?? '');
        calls.push(f);
        if (f.includes('tolower')) {
          throw new BpmApiError('The query specified in the URI is not valid', 400);
        }
        if (f.includes('contains(Name')) return { value: [{ Id: 'x', Name: 'Ланит' }] };
        return { value: [] };
      },
    };
    const resolver = new LookupResolver(makeCfg(), od as never, {} as never);
    const r = await resolver.resolve('Account', 'ланит', 'Name', { fuzzy: true });
    expect(r.resolved).toBe(true);

    await resolver.resolve('Account', 'другой', 'Name', { fuzzy: true });
    const tolowerCalls = calls.filter((f) => f.includes('tolower'));
    expect(tolowerCalls).toHaveLength(1);
  });
});
