/**
 * Shared helpers for MCP tools — init guard and standardized error/result formatting.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceContainer } from './init-tool.js';
import type { ResolvedLookupNote } from '../lookup/lookup-resolver.js';
import type { MetadataManager } from '../metadata/metadata-manager.js';
import {
  BpmApiError,
  LookupResolutionError,
  UnknownCollectionError,
  UnknownFieldError,
} from '../utils/errors.js';
import { getDisplayColumn, fieldCorrectionNote } from '../utils/display.js';
import { compileFilter, type CompileResult, type CriterionNode } from '../utils/filter-compiler.js';
import { createResolutionContext, type ResolutionContext } from '../lookup/resolution-context.js';
import type { EntityProperty } from '../types/index.js';
import { literalizeFieldValue } from '../utils/field-values.js';
import { assertSafeIdentifier } from '../utils/odata.js';

const initializationError = {
  success: false,
  code: 'not_initialized',
  error: 'Подключение к BPMSoft не настроено.',
  next_steps: ['Настройте подключение при запуске сервера. Если доступен bpm_init, можно использовать его.'],
};

export const NOT_INITIALIZED_RESULT: CallToolResult = {
  content: [
    {
      type: 'text',
      text: JSON.stringify(initializationError, null, 2),
    },
  ],
  structuredContent: initializationError,
  isError: true,
};

export function notInitialized(): CallToolResult {
  return NOT_INITIALIZED_RESULT;
}

/**
 * Wrap a handler so that if services are not initialized it returns the
 * standardized error without entering the handler body. The handler still
 * receives the (now guaranteed non-empty) container.
 */
export function withInit<TArgs, TExtra>(
  services: ServiceContainer,
  handler: (args: TArgs, extra: TExtra) => Promise<CallToolResult>
): (args: TArgs, extra: TExtra) => Promise<CallToolResult> {
  return async (args, extra) => {
    if (!services.initialized) return notInitialized();
    return handler(args, extra);
  };
}

/**
 * Build a tool result from a plain text body, preserving isError.
 */
export function textResult(text: string, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    isError,
  };
}

/**
 * Build a tool result that includes both text and structured content
 * (clients on MCP SDK >= 1.x can read structuredContent for richer UX).
 */
export function structuredResult(
  text: string,
  structured: Record<string, unknown>,
  isError = false
): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent: structured,
    isError,
  };
}

/** Человекочитаемая строка о fuzzy-резолвах lookup-полей (null, если их не было). */
export function lookupNotesText(notes: ResolvedLookupNote[]): string | null {
  if (notes.length === 0) return null;
  const parts = notes.map((n) => `${n.field}: "${n.input}" → "${n.matchedValue}"`);
  return `Неточно разрешены lookup-поля: ${parts.join('; ')}`;
}

/** snake_case-представление notes для structuredContent (resolved_lookups). */
export function lookupNotesStructured(
  notes: ResolvedLookupNote[]
): Array<{ field: string; input: string; matched_value: string; match_type: 'contains' | 'core' }> {
  return notes.map((n) => ({
    field: n.field,
    input: n.input,
    matched_value: n.matchedValue,
    match_type: n.matchType,
  }));
}

/**
 * Каноническое имя EntitySet по тому, что передал клиент.
 *
 * Модель пишет «Контакт», «contact» или с опечаткой — сервер обязан сопоставить
 * это со схемой сам. Без резолва кириллица падала на `assertSafeIdentifier`
 * («допустимы только латинские буквы»), а опечатка — на 404 без подсказок,
 * хотя `resolveCollectionReference` умеет и то, и другое.
 */
export async function resolveCollectionName(services: ServiceContainer, input: string): Promise<string> {
  return (await resolveCollection(services, input)).name;
}

/**
 * То же, что `resolveCollectionName`, плюс заметка об исправлении («Коллекция «Контакты» → Contact»).
 * `autoCorrect` (множественное число подписи, опечатка) — только для путей чтения.
 */
export async function resolveCollection(
  services: ServiceContainer,
  input: string,
  options: { autoCorrect?: boolean } = {}
): Promise<{ name: string; note?: string }> {
  let ref: Awaited<ReturnType<ServiceContainer['metadataManager']['resolveCollectionReference']>>;
  try {
    ref = await services.metadataManager.resolveCollectionReference(input, options);
  } catch {
    // Схема недоступна — не мешаем запросу: пусть отвечает сам BPMSoft.
    return { name: input };
  }
  if (ref.name) {
    return 'autoCorrected' in ref && ref.autoCorrected
      ? { name: ref.name, note: `Коллекция «${input}» → ${ref.name}` }
      : { name: ref.name };
  }
  throw new UnknownCollectionError(input, 'suggestions' in ref ? ref.suggestions : []);
}

/**
 * MetadataManager, у которого resolveFieldReference исправляет однозначные опечатки и
 * складывает заметки в `notes`. Для чтения: filter-compiler получает его вместо обычного.
 * Proxy, а не наследник: состояние (кэш $metadata) остаётся в исходном экземпляре.
 */
export function autoCorrectingMetadata(mm: MetadataManager, notes: string[]): MetadataManager {
  return new Proxy(mm, {
    get(target, prop) {
      if (prop === 'resolveFieldReference') {
        return async (collection: string, query: string) => {
          const ref = await target.resolveFieldReference(collection, query, { autoCorrect: true });
          if (ref.name !== null && ref.autoCorrected) notes.push(fieldCorrectionNote(query, ref.name));
          return ref;
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * UUID записи по тому, что передал клиент: UUID — как есть, иначе поиск по колонке
 * отображения (Name/Title/LeadName...). Модель пишет «Ромашка» и не должна сама
 * искать Id отдельным вызовом. Промах или неоднозначность — LookupResolutionError
 * с кандидатами, запись наугад не выбирается.
 */
export async function resolveRecordId(
  services: ServiceContainer,
  collection: string,
  idOrName: string,
  options: { fuzzy?: boolean } = {}
): Promise<{ id: string; matched?: string }> {
  const value = idOrName.trim();
  if (UUID_RE.test(value)) return { id: value };

  const column = (await getDisplayColumn(services.metadataManager, collection)) ?? 'Name';
  const result = await services.lookupResolver.resolve(collection, value, column, {
    fuzzy: options.fuzzy ?? true,
  });
  if (result.resolved && result.id) return { id: result.id, matched: result.matchedValue ?? value };
  throw new LookupResolutionError(column, value, result.matchCount, result.candidates, {
    lookupCollection: collection,
    displayColumn: column,
  });
}

export interface MatchByCriterion {
  field: string;
  value: unknown;
}

export interface ResolvedRecordTarget {
  id: string;
  matched?: string;
  matched_by?: {
    fields: Array<{ field: string; caption: string; type: string }>;
    values: Record<string, unknown>;
  };
}

/** Resolve a record by its existing UUID/name input or by a unique exact business-key conjunction. */
export async function resolveRecordTarget(
  services: ServiceContainer,
  collection: string,
  target: { id?: string; match_by?: MatchByCriterion[] },
  options: { fuzzy?: boolean } = {}
): Promise<ResolvedRecordTarget> {
  const hasId = typeof target.id === 'string' && target.id.trim().length > 0;
  const hasMatchBy = target.match_by !== undefined;
  if (hasId === hasMatchBy)
    throw new BpmApiError('Передайте ровно один параметр: id или match_by.', 400, collection);
  if (hasId) return resolveRecordId(services, collection, target.id!, options);

  const criteria = target.match_by!;
  if (criteria.length < 1 || criteria.length > 8)
    throw new BpmApiError('match_by должен содержать от 1 до 8 полей.', 400, collection);

  const metadata = await services.metadataManager.getEntityMetadata(collection);
  const properties = new Map(metadata.properties.map((property) => [property.name, property]));
  const seen = new Set<string>();
  const canonical: Array<{ property: EntityProperty; value: unknown }> = [];
  const input: Record<string, unknown> = {};
  for (const criterion of criteria) {
    const reference = await services.metadataManager.resolveFieldReference(collection, criterion.field);
    if (!reference.name)
      throw new UnknownFieldError(
        criterion.field,
        collection,
        'suggestions' in reference ? reference.suggestions : []
      );
    const property = properties.get(reference.name);
    if (!property) throw new UnknownFieldError(criterion.field, collection, []);
    assertSafeIdentifier(property.name, 'match_by.field');
    if (property.name === 'Id' || metadata.keyFields?.includes(property.name))
      throw new BpmApiError(
        'Для match_by передавайте бизнес-поля; UUID записи задаётся через id.',
        400,
        collection
      );
    if (['Edm.Binary', 'Edm.Stream'].includes(property.type) || property.type.startsWith('Collection('))
      throw new BpmApiError(
        `Поле ${property.caption ?? property.name} нельзя использовать в match_by.`,
        400,
        collection
      );
    if (seen.has(property.name))
      throw new BpmApiError(
        `Поле ${property.caption ?? property.name} повторяется в match_by.`,
        400,
        collection
      );
    seen.add(property.name);
    input[property.name] = criterion.value;
    canonical.push({ property, value: criterion.value });
  }

  const lookupValues: Record<string, unknown> = {};
  const nonLookupValues: Record<string, unknown> = {};
  for (const { property, value } of canonical) {
    if (!property.isLookup || typeof value !== 'string' || UUID_RE.test(value.trim())) {
      (property.isLookup ? lookupValues : nonLookupValues)[property.name] = value;
      continue;
    }
    const info = await services.metadataManager.getLookupInfo(collection, property.name);
    if (!info)
      throw new BpmApiError(
        `Для точного match_by поля ${property.caption ?? property.name} передайте UUID справочного значения.`,
        400,
        collection
      );
    const result = await services.lookupResolver.resolve(info.lookupCollection, value, info.displayColumn, {
      fuzzy: false,
    });
    if (!result.resolved || !result.id)
      throw new LookupResolutionError(info.displayColumn, value, result.matchCount, result.candidates, {
        lookupCollection: info.lookupCollection,
        displayColumn: info.displayColumn,
      });
    lookupValues[property.name] = result.id;
  }
  const resolved = await services.lookupResolver.resolveDataLookups(
    collection,
    nonLookupValues,
    createResolutionContext(services.currentUser)
  );
  const normalizedValues = { ...resolved.data, ...lookupValues };
  const where = canonical.map(({ property }) => {
    const value = normalizedValues[property.name];
    const literal = literalizeFieldValue(value, property, services.config.odata_version, collection);
    return `${property.name} eq ${literal}`;
  });
  const displayColumn = (await getDisplayColumn(services.metadataManager, collection)) ?? 'Name';
  const select = [...new Set(['Id', displayColumn, ...canonical.map(({ property }) => property.name)])].join(
    ','
  );
  const response = await services.odataClient.getRecords<Record<string, unknown>>(
    collection,
    { $filter: where.map((part) => `(${part})`).join(' and '), $select: select, $top: 2 },
    true,
    2
  );
  const candidates = response.value.map((record) => ({
    id: String(record.Id),
    displayValue: `${String(record[displayColumn] ?? record.Id)} — ${canonical
      .map(({ property }) => `${property.caption ?? property.name}: ${String(record[property.name] ?? '∅')}`)
      .join('; ')}`,
  }));
  const searchValue = canonical
    .map(
      ({ property }) =>
        `${property.caption ?? property.name}=${String(normalizedValues[property.name] ?? 'null')}`
    )
    .join(' AND ');
  if (!response.value.length)
    throw new LookupResolutionError(
      criteria.map((criterion) => criterion.field).join(' + '),
      searchValue,
      0,
      [],
      {
        lookupCollection: collection,
        displayColumn,
      }
    );
  if (
    response.value.length !== 1 ||
    response['@odata.nextLink'] ||
    (response as unknown as { __next?: string }).__next
  )
    throw new LookupResolutionError(
      criteria.map((criterion) => criterion.field).join(' + '),
      searchValue,
      2,
      candidates,
      {
        lookupCollection: collection,
        displayColumn,
      }
    );

  const record = response.value[0];
  return {
    id: String(record.Id),
    matched_by: {
      fields: canonical.map(({ property }) => ({
        field: property.name,
        caption: property.caption ?? property.name,
        type: property.type,
      })),
      values: Object.fromEntries(
        canonical.map(({ property }) => [property.name, normalizedValues[property.name]])
      ),
    },
  };
}

/**
 * criteria-DSL → $filter с поясом и «я» текущего пользователя. Общий путь для
 * поиска, подсчёта и массовых операций, чтобы модель нигде не собирала $filter руками.
 */
export async function compileCriteria(
  services: ServiceContainer,
  collection: string,
  criteria: CriterionNode[],
  join?: 'and' | 'or',
  options: { autoCorrect?: boolean; resolutionContext?: ResolutionContext } = {}
): Promise<CompileResult> {
  const resolutionContext = options.resolutionContext ?? createResolutionContext(services.currentUser);
  const notes: string[] = [];
  const compiled = await compileFilter(criteria, {
    collection,
    metadataManager: options.autoCorrect
      ? autoCorrectingMetadata(services.metadataManager, notes)
      : services.metadataManager,
    odataVersion: services.config.odata_version,
    join,
    resolutionContext,
    lookupResolver: services.lookupResolver,
  });
  compiled.warnings.unshift(...new Set(notes));
  return compiled;
}

/** Сырой $filter и скомпилированные criteria через and; пустые части отбрасываются. */
export function combineFilters(...filters: Array<string | undefined>): string | undefined {
  const parts = filters.map((f) => f?.trim()).filter((f): f is string => Boolean(f));
  if (parts.length === 0) return undefined;
  return parts.length === 1 ? parts[0] : parts.map((f) => `(${f})`).join(' and ');
}
