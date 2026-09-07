/**
 * Lookup Resolver for BPMSoft
 *
 * Resolves human-readable values (e.g. "Moscow") into UUIDs for lookup
 * (reference) fields. Identifier escape via utils/odata, bounded LRU cache.
 */

import type { BpmConfig, LookupResult, LookupCandidate } from '../types/index.js';
import { ODataClient } from '../client/odata-client.js';
import { MetadataManager } from '../metadata/metadata-manager.js';
import { LookupResolutionError, UnknownFieldError, isQueryUnsupportedError } from '../utils/errors.js';
import { assertSafeIdentifier, escapeODataString, containsExpression } from '../utils/odata.js';
import { normalizeName, scoreCandidate, pickConfidentIndex } from '../utils/name-normalize.js';
import { isTolowerSupported, markTolowerUnsupported } from '../utils/server-capabilities.js';
import { getAuthCacheScope } from '../auth/request-context.js';

interface CacheEntry {
  result: LookupResult;
  timestamp: number;
}

/** Пометка о неточно (fuzzy) разрешённом lookup-поле на write-пути. */
export interface ResolvedLookupNote {
  field: string;
  input: string;
  matchedValue: string;
  matchType: 'contains' | 'core';
}

/** Результат resolveDataLookups: подготовленные данные + пометки о fuzzy-резолвах. */
export interface ResolvedData {
  data: Record<string, unknown>;
  notes: ResolvedLookupNote[];
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

    const cacheKey = `${getAuthCacheScope()}:${lookupCollection}:${displayColumn}:${displayValue}:${options.fuzzy ? 'fuzzy' : 'eq'}`;

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
    let matchType: 'exact' | 'contains' | 'core' = 'exact';

    if (candidates.length === 0 && options.fuzzy) {
      const query = normalizeName(displayValue);
      matchType = 'contains';
      candidates = await this.queryContains(lookupCollection, displayColumn, query.normalized);
      if (candidates.length === 0 && query.core !== query.normalized) {
        matchType = 'core';
        candidates = await this.queryContains(lookupCollection, displayColumn, query.core);
      }
      if (candidates.length > 0) {
        const scores = candidates.map((c) => scoreCandidate(query, normalizeName(c.displayValue)));
        candidates = candidates
          .map((c, i) => ({ ...c, score: scores[i] }))
          .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
        const confident = pickConfidentIndex(scores);
        if (confident !== null) {
          const winner = candidates[0];
          const result: LookupResult = {
            resolved: true,
            id: winner.id,
            searchValue: displayValue,
            matchCount: 1,
            candidates: [winner],
            fuzzy: true,
            matchType,
            matchedValue: winner.displayValue,
          };
          this.cacheSet(cacheKey, { result, timestamp: Date.now() });
          return result;
        }
      }
    }

    const usedFuzzy = matchType !== 'exact' && candidates.length > 0;

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
        matchType: 'exact',
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
   * Substring-этап каскада: contains/substringof по нормализованному значению.
   * Первый отказ на tolower() переводит весь процесс в case-sensitive режим.
   */
  private async queryContains(
    lookupCollection: string,
    displayColumn: string,
    loweredValue: string
  ): Promise<LookupCandidate[]> {
    const version = this.config.odata_version;
    if (isTolowerSupported()) {
      try {
        const filter = containsExpression(displayColumn, loweredValue, version, { caseInsensitive: true });
        return await this.queryCandidates(lookupCollection, displayColumn, filter, 50);
      } catch (error) {
        if (!isQueryUnsupportedError(error)) throw error;
        markTolowerUnsupported();
      }
    }
    const filter = containsExpression(displayColumn, loweredValue, version);
    return this.queryCandidates(lookupCollection, displayColumn, filter, 50);
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
  async resolveDataLookups(collection: string, data: Record<string, unknown>): Promise<ResolvedData> {
    // Схему тянем заранее: неверная коллекция должна падать сразу, а не на
    // первом же поле, и дальше все резолвы полей идут по прогретому кэшу.
    await this.metadataManager.getEntityMetadata(collection);

    // Поля независимы друг от друга, поэтому резолвим их параллельно. На
    // bpm_batch_create из сотни записей последовательный обход давал сотни
    // запросов друг за другом; кэш спасал только со второй записи.
    const entries = await Promise.all(
      Object.entries(data).map(async ([rawKey, value]) => {
        const fieldRef = await this.metadataManager.resolveFieldReference(collection, rawKey);

        // Неизвестный ключ раньше молча уходил в BPMSoft и возвращался сырым
        // 400. Сервер знает схему — пусть скажет сам, с подсказками.
        if (fieldRef.name === null) {
          throw new UnknownFieldError(rawKey, collection, fieldRef.suggestions);
        }
        const normalizedKey = fieldRef.name;

        if (typeof value !== 'string' || this.isUuid(value)) {
          return { key: normalizedKey, value, note: null };
        }

        const lookupInfo = await this.metadataManager.getLookupInfo(collection, normalizedKey);
        if (!lookupInfo) {
          return { key: normalizedKey, value, note: null };
        }

        // Пустая строка в lookup-поле — это «очистить связь», а не значение для поиска.
        if (value.trim() === '') {
          return { key: normalizedKey, value: null, note: null };
        }

        const lookupResult = await this.resolve(
          lookupInfo.lookupCollection,
          value,
          lookupInfo.displayColumn,
          { fuzzy: true }
        );

        if (lookupResult.resolved && lookupResult.id) {
          const note =
            lookupResult.fuzzy && lookupResult.matchedValue && lookupResult.matchType !== 'exact'
              ? {
                  field: normalizedKey,
                  input: value,
                  matchedValue: lookupResult.matchedValue,
                  matchType: lookupResult.matchType ?? ('contains' as const),
                }
              : null;
          return { key: normalizedKey, value: lookupResult.id, note };
        }

        // Значение не разрешилось — обогащаем ошибку допустимыми значениями
        // справочника, чтобы LLM-агент мог сразу выбрать корректное.
        const validValues =
          lookupResult.matchCount === 0
            ? await this.sampleValues(lookupInfo.lookupCollection, lookupInfo.displayColumn)
            : undefined;
        throw new LookupResolutionError(rawKey, value, lookupResult.matchCount, lookupResult.candidates, {
          lookupCollection: lookupInfo.lookupCollection,
          displayColumn: lookupInfo.displayColumn,
          validValues,
        });
      })
    );

    const resolved: Record<string, unknown> = {};
    const notes: ResolvedLookupNote[] = [];
    for (const entry of entries) {
      resolved[entry.key] = entry.value;
      if (entry.note) notes.push(entry.note as ResolvedLookupNote);
    }

    return { data: resolved, notes };
  }

  /** Выборка первых значений справочника для контекста ошибок (ошибки сети глотаются). */
  private async sampleValues(lookupCollection: string, displayColumn: string): Promise<string[] | undefined> {
    try {
      const response = await this.odataClient.getRecords<Record<string, unknown>>(lookupCollection, {
        $select: `Id,${displayColumn}`,
        $top: 20,
        $orderby: `${displayColumn} asc`,
      });
      const values = response.value.map((r) => String(r[displayColumn] ?? '')).filter(Boolean);
      return values.length > 0 ? values : undefined;
    } catch {
      return undefined;
    }
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
    filter: string,
    top: number = 10
  ): Promise<LookupCandidate[]> {
    const response = await this.odataClient.getRecords<Record<string, unknown>>(lookupCollection, {
      $filter: filter,
      $select: `Id,${displayColumn}`,
      $top: top,
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
