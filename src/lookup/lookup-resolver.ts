/**
 * Lookup Resolver for BPMSoft
 *
 * Resolves human-readable values (e.g. "Moscow") into UUIDs for lookup
 * (reference) fields. Identifier escape via utils/odata, bounded LRU cache.
 */

import type { BpmConfig, LookupResult, LookupCandidate } from '../types/index.js';
import { ODataClient } from '../client/odata-client.js';
import { MetadataManager } from '../metadata/metadata-manager.js';
import { LookupResolutionError } from '../utils/errors.js';
import { assertSafeIdentifier, escapeODataString } from '../utils/odata.js';

interface CacheEntry {
  result: LookupResult;
  timestamp: number;
}

const DEFAULT_CACHE_MAX = 1000;

export class LookupResolver {
  /** LRU is implemented via Map insertion order: re-set on hit, delete oldest on overflow. */
  private cache = new Map<string, CacheEntry>();
  private readonly maxCacheSize: number;

  constructor(
    private config: BpmConfig,
    private odataClient: ODataClient,
    private metadataManager: MetadataManager,
    options: { maxCacheSize?: number } = {}
  ) {
    this.maxCacheSize = options.maxCacheSize ?? DEFAULT_CACHE_MAX;
  }

  async resolve(
    lookupCollection: string,
    displayValue: string,
    displayColumn: string = 'Name',
    options: { fuzzy?: boolean } = {}
  ): Promise<LookupResult> {
    assertSafeIdentifier(lookupCollection, 'lookup collection');
    assertSafeIdentifier(displayColumn, 'lookup column');

    const cacheKey = `${lookupCollection}:${displayColumn}:${displayValue}:${options.fuzzy ? 'fuzzy' : 'eq'}`;

    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.config.lookup_cache_ttl * 1000) {
      // LRU eviction: re-set on hit
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, cached);
      return cached.result;
    }

    const escaped = escapeODataString(displayValue);
    const filter = `${displayColumn} eq '${escaped}'`;
    let candidates = await this.queryCandidates(lookupCollection, displayColumn, filter);

    let usedFuzzy = false;
    if (candidates.length === 0 && options.fuzzy) {
      const fuzzyFilter = `contains(${displayColumn},'${escaped}')`;
      candidates = await this.queryCandidates(lookupCollection, displayColumn, fuzzyFilter);
      usedFuzzy = candidates.length > 0;
    }

    let result: LookupResult;
    if (candidates.length === 0) {
      result = {
        resolved: false,
        searchValue: displayValue,
        matchCount: 0,
        candidates: [],
        error: `Значение "${displayValue}" не найдено в ${lookupCollection}.${displayColumn}`,
      };
    } else if (candidates.length === 1 && !usedFuzzy) {
      result = {
        resolved: true,
        id: candidates[0].id,
        searchValue: displayValue,
        matchCount: 1,
        candidates,
      };
    } else {
      result = {
        resolved: false,
        searchValue: displayValue,
        matchCount: candidates.length,
        candidates,
        error: usedFuzzy
          ? `Точное совпадение для "${displayValue}" не найдено; предложены ${candidates.length} нечёткое(их) совпадение(ий) — уточните выбор.`
          : `Найдено ${candidates.length} совпадений для "${displayValue}" в ${lookupCollection}.${displayColumn}. Уточните значение.`,
      };
    }

    this.cacheSet(cacheKey, { result, timestamp: Date.now() });
    return result;
  }

  /**
   * Process a data object for create/update.
   *
   * Accepts BOTH english identifiers ("CityId") and Russian captions ("Город")
   * as keys. Captions are resolved through MetadataManager.resolveFieldReference,
   * which uses the SysSchema/SysEntitySchemaColumn caption cache.
   *
   * Detects lookup fields and resolves human-readable values to UUIDs.
   */
  async resolveDataLookups(
    collection: string,
    data: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const resolved: Record<string, unknown> = {};
    // Force metadata load early so a wrong collection fails fast
    await this.metadataManager.getEntityMetadata(collection);

    for (const [rawKey, value] of Object.entries(data)) {
      // Resolve key first — translate caption → name when possible
      const fieldRef = await this.metadataManager.resolveFieldReference(collection, rawKey);
      const normalizedKey = fieldRef.name ?? rawKey;

      if (typeof value !== 'string') {
        resolved[normalizedKey] = value;
        continue;
      }
      if (this.isUuid(value)) {
        resolved[normalizedKey] = value;
        continue;
      }

      const lookupInfo = await this.metadataManager.getLookupInfo(collection, normalizedKey);

      if (!lookupInfo) {
        resolved[normalizedKey] = value;
        continue;
      }

      const lookupResult = await this.resolve(lookupInfo.lookupCollection, value, lookupInfo.displayColumn);

      if (lookupResult.resolved && lookupResult.id) {
        resolved[normalizedKey] = lookupResult.id;
      } else {
        throw new LookupResolutionError(
          rawKey,
          value,
          lookupResult.matchCount,
          lookupResult.candidates
        );
      }
    }

    return resolved;
  }

  /** Manually look up a value — exposed as bpm_lookup_value tool */
  async lookupValue(
    collection: string,
    field: string,
    value: string,
    options: { fuzzy?: boolean } = {}
  ): Promise<LookupResult> {
    return this.resolve(collection, value, field, options);
  }

  clearCache(): void {
    this.cache.clear();
  }

  private async queryCandidates(
    lookupCollection: string,
    displayColumn: string,
    filter: string
  ): Promise<LookupCandidate[]> {
    const response = await this.odataClient.getRecords<Record<string, unknown>>(lookupCollection, {
      $filter: filter,
      $select: `Id,${displayColumn}`,
      $top: 10,
    });
    return response.value.map((record) => ({
      id: String(record.Id || record.id),
      displayValue: String(record[displayColumn] || ''),
    }));
  }

  private cacheSet(key: string, entry: CacheEntry): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxCacheSize) {
      // Evict oldest (first-inserted) entry — basic LRU on insertion order.
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) this.cache.delete(oldestKey);
    }
    this.cache.set(key, entry);
  }

  private isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  }
}
