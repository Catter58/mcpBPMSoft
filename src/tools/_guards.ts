/**
 * Shared helpers for MCP tools — init guard and standardized error/result formatting.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceContainer } from './init-tool.js';
import type { ResolvedLookupNote } from '../lookup/lookup-resolver.js';
import type { MetadataManager } from '../metadata/metadata-manager.js';
import { LookupResolutionError, UnknownCollectionError } from '../utils/errors.js';
import { getDisplayColumn, fieldCorrectionNote } from '../utils/display.js';
import { compileFilter, type CompileResult, type Criterion } from '../utils/filter-compiler.js';

export const NOT_INITIALIZED_RESULT: CallToolResult = {
  content: [
    {
      type: 'text',
      text: JSON.stringify(
        {
          success: false,
          code: 'not_initialized',
          error: 'Сервер не инициализирован. Сначала вызовите bpm_init с параметрами подключения.',
          next_steps: ['Вызовите bpm_init с URL, логином и паролем BPMSoft.'],
        },
        null,
        2
      ),
    },
  ],
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
  idOrName: string
): Promise<{ id: string; matched?: string }> {
  const value = idOrName.trim();
  if (UUID_RE.test(value)) return { id: value };

  const column = (await getDisplayColumn(services.metadataManager, collection)) ?? 'Name';
  const result = await services.lookupResolver.resolve(collection, value, column, { fuzzy: true });
  if (result.resolved && result.id) return { id: result.id, matched: result.matchedValue ?? value };
  throw new LookupResolutionError(column, value, result.matchCount, result.candidates, {
    lookupCollection: collection,
    displayColumn: column,
  });
}

/**
 * criteria-DSL → $filter с поясом и «я» текущего пользователя. Общий путь для
 * поиска, подсчёта и массовых операций, чтобы модель нигде не собирала $filter руками.
 */
export async function compileCriteria(
  services: ServiceContainer,
  collection: string,
  criteria: Criterion[],
  join?: 'and' | 'or',
  options: { autoCorrect?: boolean } = {}
): Promise<CompileResult> {
  let timeZone: string | undefined;
  try {
    timeZone = (await services.currentUser.get()).timeZoneId || undefined;
  } catch {
    // DataService недоступен — считаем в поясе сервера.
  }
  const notes: string[] = [];
  const compiled = await compileFilter(criteria, {
    collection,
    metadataManager: options.autoCorrect
      ? autoCorrectingMetadata(services.metadataManager, notes)
      : services.metadataManager,
    odataVersion: services.config.odata_version,
    join,
    timeZone,
    currentUser: services.currentUser,
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
