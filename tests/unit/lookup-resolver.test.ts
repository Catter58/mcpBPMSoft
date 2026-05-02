import { describe, it, expect } from 'vitest';
import { LookupResolver } from '../../src/lookup/lookup-resolver.js';
import type { BpmConfig, ODataCollectionResponse } from '../../src/types/index.js';

function makeCfg(): BpmConfig {
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
  };
}

interface StubODataClient {
  getRecords: (
    collection: string,
    query?: { $filter?: string; $select?: string; $top?: number }
  ) => Promise<ODataCollectionResponse<Record<string, unknown>>>;
  calls: Array<{ collection: string; filter?: string }>;
}

function makeStubODataClient(
  responder: (filter?: string) => Array<Record<string, unknown>>
): StubODataClient {
  const calls: Array<{ collection: string; filter?: string }> = [];
  return {
    calls,
    async getRecords(collection, query) {
      calls.push({ collection, filter: query?.$filter });
      return { value: responder(query?.$filter) };
    },
  };
}

describe('LookupResolver.resolve', () => {
  it('returns resolved=true with a single match', async () => {
    const od = makeStubODataClient(() => [{ Id: 'guid-1', Name: 'Moscow' }]);
    const resolver = new LookupResolver(
      makeCfg(),
      od as never,
      {} as never,
      { maxCacheSize: 10 }
    );

    const r = await resolver.resolve('City', 'Moscow');
    expect(r.resolved).toBe(true);
    expect(r.id).toBe('guid-1');
    expect(r.matchCount).toBe(1);
  });

  it('returns resolved=false with multiple candidates', async () => {
    const od = makeStubODataClient(() => [
      { Id: 'a', Name: 'Moscow' },
      { Id: 'b', Name: 'Moscow' },
    ]);
    const resolver = new LookupResolver(makeCfg(), od as never, {} as never);

    const r = await resolver.resolve('City', 'Moscow');
    expect(r.resolved).toBe(false);
    expect(r.matchCount).toBe(2);
    expect(r.candidates).toHaveLength(2);
  });

  it('falls back to fuzzy contains() and returns matchCount>0, resolved=false', async () => {
    let call = 0;
    const od = makeStubODataClient((filter) => {
      call += 1;
      // First call (eq) returns nothing; second call (contains) returns matches.
      if (call === 1) {
        expect(filter).toContain('eq');
        return [];
      }
      expect(filter).toContain('contains(');
      return [{ Id: 'a', Name: 'Moscow' }];
    });
    const resolver = new LookupResolver(makeCfg(), od as never, {} as never);

    const r = await resolver.resolve('City', 'Mos', 'Name', { fuzzy: true });
    expect(r.resolved).toBe(false);
    expect(r.matchCount).toBe(1);
    expect(r.candidates).toHaveLength(1);
    expect(od.calls).toHaveLength(2);
  });
});

describe('LookupResolver LRU cache', () => {
  it('evicts oldest entry when maxCacheSize=2 and a 3rd unique key is written', async () => {
    let call = 0;
    const od = makeStubODataClient(() => [{ Id: `guid-${++call}`, Name: 'X' }]);
    const resolver = new LookupResolver(
      makeCfg(),
      od as never,
      {} as never,
      { maxCacheSize: 2 }
    );

    await resolver.resolve('City', 'A');
    await resolver.resolve('City', 'B');
    expect(od.calls).toHaveLength(2);

    // Third unique key — should evict "A"
    await resolver.resolve('City', 'C');
    expect(od.calls).toHaveLength(3);

    // "B" still cached — no new call
    await resolver.resolve('City', 'B');
    expect(od.calls).toHaveLength(3);

    // "A" evicted — must hit network again
    await resolver.resolve('City', 'A');
    expect(od.calls).toHaveLength(4);
  });
});
