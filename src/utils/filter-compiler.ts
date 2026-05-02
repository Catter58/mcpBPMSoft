/**
 * Semantic filter DSL compiler.
 *
 * Translates an array of human-friendly criteria like
 *   [{ field: 'Город', op: 'равно', value: 'Москва' }]
 * into a safe OData $filter string, using metadata to resolve fields
 * (captions, navigation paths) and to detect lookup columns.
 *
 * Goals:
 *   - LLM agents stop hand-writing OData syntax (eq/ne/contains/etc.)
 *     and stop guessing field names. Russian captions and dotted
 *     navigation paths are accepted.
 *   - Generated filters are safe by construction — every identifier is
 *     validated, every value is escaped through escapeODataString.
 *
 * Out of scope:
 *   - Resolving lookup TEXT into UUID. We surface a warning instead and
 *     ask the caller to use bpm_lookup_value first. Doing it here would
 *     pull LookupResolver into the compile path; the criteria-DSL
 *     contract keeps that dependency optional.
 */

import type { MetadataManager } from '../metadata/metadata-manager.js';
import { UnknownFieldError } from './errors.js';
import { escapeODataString, isSafeIdentifier } from './odata.js';

export interface Criterion {
  /** Field name, caption ("Город") or navigation path ("Account.City"). */
  field: string;
  /** Operator — Russian synonym or canonical OData op. */
  op: string;
  /** Right-hand value. Optional for is_null / is_not_null. */
  value?: unknown;
  /** Upper bound for `between`. */
  value_to?: unknown;
}

export interface CompileOptions {
  collection: string;
  metadataManager: MetadataManager;
  odataVersion: 3 | 4;
  /** How to combine multiple criteria. Default 'and'. */
  join?: 'and' | 'or';
}

export interface UsedField {
  input: string;
  resolved: string;
  caption?: string;
}

export interface CompileResult {
  /** Ready-to-use $filter expression. */
  filter: string;
  used_fields: UsedField[];
  warnings: string[];
}

type CanonicalOp =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'ge'
  | 'lt'
  | 'le'
  | 'contains'
  | 'startswith'
  | 'endswith'
  | 'in'
  | 'is_null'
  | 'is_not_null'
  | 'in_last_days'
  | 'in_last_hours'
  | 'between'
  | 'not_contains';

const OP_ALIASES: Record<string, CanonicalOp> = {
  // eq
  'равно': 'eq',
  'eq': 'eq',
  // ne
  'не равно': 'ne',
  'ne': 'ne',
  // gt / ge / lt / le
  'больше': 'gt',
  'gt': 'gt',
  'больше или равно': 'ge',
  'ge': 'ge',
  'меньше': 'lt',
  'lt': 'lt',
  'меньше или равно': 'le',
  'le': 'le',
  // contains / startswith / endswith
  'содержит': 'contains',
  'contains': 'contains',
  'начинается с': 'startswith',
  'startswith': 'startswith',
  'заканчивается на': 'endswith',
  'endswith': 'endswith',
  // in
  'в списке': 'in',
  'in': 'in',
  // null
  'пусто': 'is_null',
  'is_null': 'is_null',
  'не пусто': 'is_not_null',
  'is_not_null': 'is_not_null',
  // date windows
  'за последние n дней': 'in_last_days',
  'in_last_days': 'in_last_days',
  'за последние n часов': 'in_last_hours',
  'in_last_hours': 'in_last_hours',
  // range
  'между': 'between',
  'between': 'between',
  // not contains
  'не содержит': 'not_contains',
  'not_contains': 'not_contains',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function compileFilter(
  criteria: Criterion[],
  options: CompileOptions
): Promise<CompileResult> {
  if (!Array.isArray(criteria) || criteria.length === 0) {
    return { filter: '', used_fields: [], warnings: [] };
  }

  const used: UsedField[] = [];
  const warnings: string[] = [];
  const expressions: string[] = [];

  for (const criterion of criteria) {
    if (!criterion || typeof criterion.field !== 'string' || typeof criterion.op !== 'string') {
      throw new Error(
        'Каждый critera должен быть объектом вида {field: string, op: string, value?: any}.'
      );
    }

    const op = canonicalOp(criterion.op);
    const resolved = await resolveFieldPath(criterion.field, options);

    used.push({ input: criterion.field, resolved: resolved.path, caption: resolved.caption });
    if (resolved.lookupWarning) warnings.push(resolved.lookupWarning);

    const expr = buildExpression(resolved.path, op, criterion, options.odataVersion, resolved.isLookup);
    expressions.push(expr);
  }

  const join = options.join === 'or' ? ' or ' : ' and ';
  // Wrap individual expressions in parens only when there's more than one,
  // to keep simple cases readable while preserving precedence.
  const filter =
    expressions.length === 1 ? expressions[0] : expressions.map((e) => `(${e})`).join(join);

  return { filter, used_fields: used, warnings };
}

function canonicalOp(input: string): CanonicalOp {
  const trimmed = input.trim();
  const lower = trimmed.toLowerCase();

  // Direct hit.
  const direct = OP_ALIASES[lower];
  if (direct) return direct;

  // Pattern hits like "за последние 7 дней" / "in_last_days N" — we let
  // numeric arguments flow via `value`, so any leading prefix match works.
  if (lower.startsWith('за последние ') && lower.endsWith(' дней')) return 'in_last_days';
  if (lower.startsWith('за последние ') && lower.endsWith(' часов')) return 'in_last_hours';

  throw new Error(
    `Неизвестный оператор: "${input}". Допустимые: равно/eq, не равно/ne, больше/gt, ` +
      `больше или равно/ge, меньше/lt, меньше или равно/le, содержит/contains, ` +
      `не содержит/not_contains, начинается с/startswith, заканчивается на/endswith, ` +
      `в списке/in, пусто/is_null, не пусто/is_not_null, ` +
      `за последние N дней/in_last_days, за последние N часов/in_last_hours, между/between.`
  );
}

interface ResolvedField {
  /** OData identifier path with '/' separators ('Account/City') */
  path: string;
  /** Caption of the FIRST resolved segment (if any). */
  caption?: string;
  /** Whether final segment is a lookup column (e.g. CityId). */
  isLookup: boolean;
  /** Optional warning about lookup-by-text. */
  lookupWarning?: string;
}

async function resolveFieldPath(query: string, options: CompileOptions): Promise<ResolvedField> {
  // Accept both '.' and '/' as separators; OData itself uses '/'.
  const segments = query
    .split(/[./]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (segments.length === 0) {
    throw new Error(`Пустое имя поля: "${query}".`);
  }

  let currentCollection = options.collection;
  const resolvedSegments: string[] = [];
  let firstCaption: string | undefined;
  let isLookup = false;
  let lookupWarning: string | undefined;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const ref = await options.metadataManager.resolveFieldReference(currentCollection, seg);

    if (!('name' in ref) || ref.name === null) {
      // No match — surface UnknownFieldError so formatToolError lights up
      // suggestions/next_steps for the LLM.
      const suggestions = 'suggestions' in ref && Array.isArray(ref.suggestions) ? ref.suggestions : [];
      throw new UnknownFieldError(query, currentCollection, suggestions);
    }

    const fieldName = ref.name;
    if (!isSafeIdentifier(fieldName)) {
      // resolveFieldReference returns metadata-derived names, but enforce the
      // invariant once more so the URL builder never sees a tainted segment.
      throw new Error(`Небезопасное имя поля от metadata: "${fieldName}".`);
    }

    if (i === 0) {
      const meta = await options.metadataManager.getEntityMetadata(currentCollection);
      const prop = meta.properties.find((p) => p.name === fieldName);
      firstCaption = prop?.caption;
    }

    const isLastSegment = i === segments.length - 1;

    if (!isLastSegment) {
      // Mid-path: must be a navigation property. v4 uses navigation name like
      // 'Account' (not 'AccountId'); v3 uses the bare lookup field name. We
      // detect via getLookupInfo on the FK column when applicable.
      const lookupInfo = await options.metadataManager.getLookupInfo(currentCollection, fieldName);
      let nextCollection: string | null = null;
      let navSegmentName: string;

      if (lookupInfo) {
        nextCollection = lookupInfo.lookupCollection;
        // For v4 strip trailing 'Id' so '/Account/Name' navigation works
        // (CityId is the FK column, City is the navigation property).
        navSegmentName =
          options.odataVersion === 4 && fieldName.endsWith('Id') ? fieldName.slice(0, -2) : fieldName;
      } else {
        // Could already be a navigation name — try resolving via metadata directly.
        const meta = await options.metadataManager.getEntityMetadata(currentCollection);
        const prop = meta.properties.find(
          (p) => p.name === fieldName || (p.isLookup && p.name.replace(/Id$/, '') === fieldName)
        );
        if (!prop || !prop.isLookup || !prop.lookupCollection) {
          throw new UnknownFieldError(query, currentCollection, [
            `Сегмент "${seg}" в пути "${query}" не является навигационной (lookup) ссылкой.`,
          ]);
        }
        nextCollection = prop.lookupCollection;
        navSegmentName =
          options.odataVersion === 4 && fieldName.endsWith('Id') ? fieldName.slice(0, -2) : fieldName;
      }

      if (!isSafeIdentifier(navSegmentName)) {
        throw new Error(`Небезопасное имя навигации: "${navSegmentName}".`);
      }

      resolvedSegments.push(navSegmentName);
      currentCollection = nextCollection;
    } else {
      resolvedSegments.push(fieldName);
      const lookupInfo = await options.metadataManager.getLookupInfo(currentCollection, fieldName);
      if (lookupInfo) {
        isLookup = true;
        lookupWarning =
          `Поле "${query}" является lookup; передайте UUID или используйте bpm_lookup_value для ` +
          `получения UUID по тексту.`;
      }
    }
  }

  return {
    path: resolvedSegments.join('/'),
    caption: firstCaption,
    isLookup,
    lookupWarning,
  };
}

function buildExpression(
  fieldPath: string,
  op: CanonicalOp,
  criterion: Criterion,
  odataVersion: 3 | 4,
  isLookup: boolean
): string {
  switch (op) {
    case 'eq':
    case 'ne':
    case 'gt':
    case 'ge':
    case 'lt':
    case 'le':
      return `${fieldPath} ${op} ${literalize(criterion.value, odataVersion, isLookup)}`;

    case 'contains':
      return `contains(${fieldPath}, ${stringLiteral(criterion.value)})`;

    case 'not_contains':
      return `not contains(${fieldPath}, ${stringLiteral(criterion.value)})`;

    case 'startswith':
      return `startswith(${fieldPath}, ${stringLiteral(criterion.value)})`;

    case 'endswith':
      return `endswith(${fieldPath}, ${stringLiteral(criterion.value)})`;

    case 'in': {
      if (!Array.isArray(criterion.value) || criterion.value.length === 0) {
        throw new Error(`Оператор "in" требует value=массив с минимум одним элементом.`);
      }
      const parts = criterion.value.map(
        (v) => `${fieldPath} eq ${literalize(v, odataVersion, isLookup)}`
      );
      return parts.length === 1 ? parts[0] : `(${parts.join(' or ')})`;
    }

    case 'is_null':
      return `${fieldPath} eq null`;

    case 'is_not_null':
      return `${fieldPath} ne null`;

    case 'in_last_days': {
      const days = numericValue(criterion.value, op);
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      return `${fieldPath} ge ${dateTimeLiteral(since, odataVersion)}`;
    }

    case 'in_last_hours': {
      const hours = numericValue(criterion.value, op);
      const since = new Date(Date.now() - hours * 60 * 60 * 1000);
      return `${fieldPath} ge ${dateTimeLiteral(since, odataVersion)}`;
    }

    case 'between': {
      if (criterion.value === undefined || criterion.value_to === undefined) {
        throw new Error(`Оператор "between" требует value (нижняя граница) и value_to (верхняя граница).`);
      }
      const lo = literalize(criterion.value, odataVersion, isLookup);
      const hi = literalize(criterion.value_to, odataVersion, isLookup);
      return `${fieldPath} ge ${lo} and ${fieldPath} le ${hi}`;
    }
  }
}

function literalize(value: unknown, odataVersion: 3 | 4, isLookup: boolean): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);

  if (value instanceof Date) {
    return dateTimeLiteral(value, odataVersion);
  }

  if (typeof value === 'string') {
    if (UUID_RE.test(value)) {
      return odataVersion === 3 ? `guid'${value}'` : value;
    }
    if (isIsoDateLike(value)) {
      const d = new Date(value);
      if (!Number.isNaN(d.getTime())) {
        return dateTimeLiteral(d, odataVersion);
      }
    }
    // Fallthrough — treat as string. For lookup-typed columns this will not
    // produce a usable filter, but compileFilter has already attached a
    // warning telling the caller to resolve the UUID first. Returning the
    // string literal at least keeps the operator well-formed.
    void isLookup;
    return stringLiteral(value);
  }

  // Fallback — toString, escaped as string. Better than crashing.
  return stringLiteral(String(value));
}

function stringLiteral(value: unknown): string {
  if (typeof value !== 'string') {
    return `'${escapeODataString(String(value ?? ''))}'`;
  }
  return `'${escapeODataString(value)}'`;
}

function dateTimeLiteral(date: Date, odataVersion: 3 | 4): string {
  // ISO 8601 without fractional seconds — tolerated by both v3 and v4 servers.
  const iso = date.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return odataVersion === 3 ? `datetime'${iso.replace(/Z$/, '')}'` : iso;
}

function numericValue(value: unknown, op: CanonicalOp): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const n = Number.parseInt(value.trim(), 10);
    if (n > 0) return n;
  }
  throw new Error(`Оператор "${op}" требует value=положительное число.`);
}

function isIsoDateLike(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(value);
}
