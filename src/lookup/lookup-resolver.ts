/**
 * Lookup Resolver for BPMSoft
 *
 * Resolves human-readable values (e.g. "Moscow") into UUIDs for lookup
 * (reference) fields. Identifier escape via utils/odata, bounded LRU cache.
 */

import type { BpmConfig, LookupResult, LookupCandidate } from '../types/index.js';
import { ODataClient } from '../client/odata-client.js';
import { MetadataManager } from '../metadata/metadata-manager.js';
import {
  BpmApiError,
  LookupResolutionError,
  UnknownFieldError,
  isQueryUnsupportedError,
} from '../utils/errors.js';
import { assertSafeIdentifier, escapeODataString, containsExpression } from '../utils/odata.js';
import { normalizeName, scoreCandidate, pickConfidentIndex } from '../utils/name-normalize.js';
import { getAuthCacheScope } from '../auth/request-context.js';
import type { CurrentUserService } from '../user/current-user.js';
import { isMeMacro, meIdFor } from '../utils/me-macro.js';
import { coerceValue, needsTimeZone, type CoercedValueNote } from '../utils/coerce.js';
import { isTolowerSupported, markTolowerUnsupported } from '../utils/server-capabilities.js';
import { coerceFieldValue, UUID_RE } from '../utils/field-values.js';
import { createResolutionContext, type ResolutionContext } from './resolution-context.js';
export type { ResolutionContext } from './resolution-context.js';

interface CandidatePage {
  candidates: LookupCandidate[];
  complete: boolean;
}

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
  coerced: CoercedValueNote[];
  origins: Array<{ field: string; source: 'caller' | 'normalized' | 'lookup' | 'current_user' }>;
}

export interface ResolutionFieldError {
  rawKey: string;
  canonicalField?: string;
  error: unknown;
}
export interface ResolvedDataWithErrors extends ResolvedData {
  errors: ResolutionFieldError[];
}

const DEFAULT_CACHE_MAX = 1000;

export class LookupResolver {
  /** LRU is implemented via Map insertion order: re-set on hit, delete oldest on overflow. */
  private cache = new Map<string, CacheEntry>();
  private readonly maxCacheSize: number;
  private readonly currentUser?: CurrentUserService;

  constructor(
    private config: BpmConfig,
    private odataClient: ODataClient,
    private metadataManager: MetadataManager,
    options: { maxCacheSize?: number; currentUser?: CurrentUserService } = {}
  ) {
    this.maxCacheSize = options.maxCacheSize ?? DEFAULT_CACHE_MAX;
    this.currentUser = options.currentUser;
  }

  createResolutionContext(now: Date = new Date()): ResolutionContext {
    return createResolutionContext(this.currentUser, now);
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

    if (!displayValue.trim())
      throw new BpmApiError('Значение справочника не может быть пустым.', 400, lookupCollection);
    const escaped = escapeODataString(displayValue);
    const filter = `${displayColumn} eq '${escaped}'`;
    let page = await this.queryCandidates(lookupCollection, displayColumn, filter, 2);
    let candidates = page.candidates;
    let matchType: 'exact' | 'contains' | 'core' = 'exact';

    if (candidates.length === 0 && page.complete && options.fuzzy) {
      const query = normalizeName(displayValue);
      matchType = 'contains';
      page = await this.queryContains(lookupCollection, displayColumn, query.normalized);
      candidates = page.candidates;
      if (candidates.length === 0 && query.core !== query.normalized) {
        matchType = 'core';
        page = await this.queryContains(lookupCollection, displayColumn, query.core);
        candidates = page.candidates;
      }
      if (candidates.length > 0) {
        const scores = candidates.map((c) => scoreCandidate(query, normalizeName(c.displayValue)));
        candidates = candidates
          .map((c, i) => ({ ...c, score: scores[i] }))
          .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
        const confident = pickConfidentIndex(scores);
        if (confident !== null && page.complete) {
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
            has_more: false,
            match_count_is_exact: true,
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
    } else if (candidates.length === 1 && !usedFuzzy && page.complete) {
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
        error: !page.complete
          ? `Выборка совпадений для "${displayValue}" неполна. Автоматический выбор запрещён; уточните запись по UUID или более точному признаку.`
          : usedFuzzy
            ? `Точное совпадение для "${displayValue}" не найдено; предложены ${candidates.length} нечёткое(их) совпадение(ий) — уточните выбор.`
            : `Найдено ${candidates.length} совпадений для "${displayValue}" в ${lookupCollection}.${displayColumn}. Уточните значение.`,
      };
    }

    result.has_more = !page.complete;
    result.match_count_is_exact = page.complete;

    this.cacheSet(cacheKey, { result, timestamp: Date.now() });
    return result;
  }

  /**
   * Substring-этап каскада: contains/substringof по нормализованному значению.
   * Первый 4xx на tolower() переключает резолвер в case-sensitive режим навсегда.
   */
  private async queryContains(
    lookupCollection: string,
    displayColumn: string,
    loweredValue: string
  ): Promise<CandidatePage> {
    const version = this.config.odata_version;
    if (isTolowerSupported()) {
      try {
        const filter = containsExpression(displayColumn, loweredValue, version, { caseInsensitive: true });
        return await this.queryCandidates(lookupCollection, displayColumn, filter, 51);
      } catch (error) {
        if (!isQueryUnsupportedError(error)) throw error;
        markTolowerUnsupported();
      }
    }
    const filter = containsExpression(displayColumn, loweredValue, version);
    return this.queryCandidates(lookupCollection, displayColumn, filter, 51);
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
    data: Record<string, unknown>,
    context?: ResolutionContext
  ): Promise<ResolvedData>;
  async resolveDataLookups(
    collection: string,
    data: Record<string, unknown>,
    context: ResolutionContext,
    options: { collectErrors: true }
  ): Promise<ResolvedDataWithErrors>;
  async resolveDataLookups(
    collection: string,
    data: Record<string, unknown>,
    context: ResolutionContext = this.createResolutionContext(),
    options?: { collectErrors?: boolean }
  ): Promise<ResolvedData | ResolvedDataWithErrors> {
    // Схему тянем заранее: неверная коллекция должна падать сразу, а не на
    // первом же поле, и дальше все резолвы полей идут по прогретому кэшу.
    const entityMeta = await this.metadataManager.getEntityMetadata(collection);
    const propTypes = new Map((entityMeta?.properties ?? []).map((p) => [p.name, p]));

    const keys = new Set<string>();
    const normalized = await Promise.all(
      Object.entries(data).map(async ([rawKey, value]) => {
        const field = await this.metadataManager.resolveFieldReference(collection, rawKey);
        if (field.name === null) throw new UnknownFieldError(rawKey, collection, field.suggestions);
        if (keys.has(field.name))
          throw new BpmApiError(
            `Поле "${field.name}" передано несколько раз под разными именами.`,
            400,
            collection
          );
        keys.add(field.name);
        const property = propTypes.get(field.name);
        if (!property) throw new UnknownFieldError(rawKey, collection, []);
        return { rawKey, value, normalizedKey: field.name, prop: property };
      })
    );

    // Поля независимы друг от друга, поэтому резолвим их параллельно. На
    // bpm_batch_create из сотни записей последовательный обход давал сотни
    // запросов друг за другом; кэш спасал только со второй записи.
    const settled = await Promise.allSettled(
      normalized.map(async ({ rawKey, value, normalizedKey, prop }) => {
        // Не-lookup колонка с известным типом: приводим значение («да», «25.09.2026 15:00»).
        if (!prop.isLookup) {
          const tz = needsTimeZone(value, prop.type) ? (await context.getTimeZone()).timeZone : undefined;
          const c = coerceValue(normalizedKey, value, prop.type, tz, { now: context.now, defaultHour: 12 });
          // Неизменённое значение (строка, Guid, уже верный тип) идёт обычным путём ниже.
          if (c.changed) {
            const coerced = { field: normalizedKey, input: value, output: c.value, type: prop.type };
            return {
              key: normalizedKey,
              value: coerceFieldValue(c.value, prop, collection),
              note: null,
              coerced,
              origin: 'normalized' as const,
            };
          }
        }

        if (typeof value !== 'string' || UUID_RE.test(value.trim())) {
          return {
            key: normalizedKey,
            value: coerceFieldValue(value, prop, collection),
            note: null,
            origin: 'caller' as const,
          };
        }

        const lookupInfo = await this.metadataManager.getLookupInfo(collection, normalizedKey);
        if (!lookupInfo) {
          if (prop.isLookup && isMeMacro(value))
            throw new BpmApiError('Макрос «я» нельзя разрешить для этого lookup-поля.', 400, collection);
          return {
            key: normalizedKey,
            value: coerceFieldValue(value, prop, collection),
            note: null,
            origin: 'caller' as const,
          };
        }

        // «я» / @me в Owner, Author и т. п. — текущий пользователь, без поиска по имени.
        if (isMeMacro(value)) {
          if (
            lookupInfo.lookupCollection.replace(/Collection$/, '') !== 'Contact' &&
            lookupInfo.lookupCollection.replace(/Collection$/, '') !== 'SysAdminUnit'
          ) {
            throw new BpmApiError(
              `Макрос «я» нельзя разрешить для справочника ${lookupInfo.lookupCollection}.`,
              400,
              collection
            );
          }
          const meId = meIdFor(lookupInfo.lookupCollection, await context.getCurrentUser());
          if (!meId)
            throw new BpmApiError(
              'У текущего пользователя не указан контакт для lookup-поля.',
              400,
              collection
            );
          return { key: normalizedKey, value: meId, note: null, origin: 'current_user' as const };
        }

        // Пустая строка в lookup-поле — это «очистить связь», а не значение для поиска.
        if (value.trim() === '') {
          return {
            key: normalizedKey,
            value: coerceFieldValue(null, prop, collection),
            note: null,
            origin: 'lookup' as const,
          };
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
          return { key: normalizedKey, value: lookupResult.id, note, origin: 'lookup' as const };
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
    const coerced: CoercedValueNote[] = [];
    const origins: ResolvedData['origins'] = [];
    const errors: ResolutionFieldError[] = [];
    for (let index = 0; index < settled.length; index++) {
      const result = settled[index];
      if (result.status === 'rejected') {
        if (!options?.collectErrors) throw result.reason;
        const field = normalized[index];
        errors.push({ rawKey: field.rawKey, canonicalField: field.normalizedKey, error: result.reason });
        continue;
      }
      const entry = result.value;
      resolved[entry.key] = entry.value;
      origins.push({ field: entry.key, source: entry.origin ?? 'caller' });
      if (entry.note) notes.push(entry.note as ResolvedLookupNote);
      if ('coerced' in entry && entry.coerced) coerced.push(entry.coerced);
    }

    return options?.collectErrors
      ? { data: resolved, notes, coerced, origins, errors }
      : { data: resolved, notes, coerced, origins };
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
    top: number
  ): Promise<CandidatePage> {
    const response = await this.odataClient.getRecords<Record<string, unknown>>(
      lookupCollection,
      {
        $filter: filter,
        $select: `Id,${displayColumn}`,
        $top: top,
        $count: true,
      },
      true,
      top
    );
    const candidates = response.value.map((record) => {
      const id = record.Id ?? record.id;
      if (typeof id !== 'string' || !id)
        throw new BpmApiError('Справочник вернул запись без идентификатора.', 502, lookupCollection);
      return { id, displayValue: String(record[displayColumn] ?? '') };
    });
    return {
      candidates: Array.from(new Map(candidates.map((candidate) => [candidate.id, candidate])).values()),
      complete:
        !response['@odata.nextLink'] &&
        (response['@odata.count'] === undefined
          ? response.value.length < top
          : response['@odata.count'] === response.value.length),
    };
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
}
