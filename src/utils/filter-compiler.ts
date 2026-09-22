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
 * Lookup-колонки со строковым значением компилируются через навигацию:
 * {field: 'Тип', op: 'равно', value: 'Сотрудник'} → `Type/Name eq 'Сотрудник'`.
 * Это снимает с модели обязанность сначала доставать UUID и убирает целый класс
 * ошибок lookup_ambiguous. Проверено на стенде: фильтр и сортировка по
 * навигационному пути работают. UUID в значении по-прежнему сравнивается с
 * самой FK-колонкой — так дешевле для сервера.
 */

import type { MetadataManager } from '../metadata/metadata-manager.js';
import { UnknownFieldError } from './errors.js';
import { containsExpression, escapeODataString, isSafeIdentifier } from './odata.js';
import { normalizeName } from './name-normalize.js';
import { getDisplayColumn } from './display.js';
import { calendarRange, resolveTimeZone, zonedMidnightUtc, type CalendarPeriod } from './datetime.js';
import { isMeMacro, meIdFor } from './me-macro.js';
import type { CurrentUser } from '../user/current-user.js';

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
  /** Часовой пояс пользователя для «сегодня»/«вчера» (IANA). */
  timeZone?: string;
  /** Текущий пользователь — для «я»/@me в lookup на Contact/SysAdminUnit. */
  currentUser?: { get(): Promise<CurrentUser> };
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
  | 'not_contains'
  | 'similar_to'
  | CalendarPeriod;

const OP_ALIASES: Record<string, CanonicalOp> = {
  // eq
  равно: 'eq',
  eq: 'eq',
  // ne
  'не равно': 'ne',
  ne: 'ne',
  // gt / ge / lt / le
  больше: 'gt',
  gt: 'gt',
  'больше или равно': 'ge',
  ge: 'ge',
  меньше: 'lt',
  lt: 'lt',
  'меньше или равно': 'le',
  le: 'le',
  // contains / startswith / endswith
  содержит: 'contains',
  contains: 'contains',
  'начинается с': 'startswith',
  startswith: 'startswith',
  'заканчивается на': 'endswith',
  endswith: 'endswith',
  // in
  'в списке': 'in',
  in: 'in',
  // null
  пусто: 'is_null',
  is_null: 'is_null',
  'не пусто': 'is_not_null',
  is_not_null: 'is_not_null',
  // date windows
  'за последние n дней': 'in_last_days',
  in_last_days: 'in_last_days',
  'за последние n часов': 'in_last_hours',
  in_last_hours: 'in_last_hours',
  // range
  между: 'between',
  between: 'between',
  // not contains
  'не содержит': 'not_contains',
  not_contains: 'not_contains',
  // fuzzy similarity (кавычки/орг-формы/регистр игнорируются)
  'похоже на': 'similar_to',
  similar_to: 'similar_to',
  // календарные периоды в часовом поясе пользователя, а не в UTC
  сегодня: 'today',
  today: 'today',
  вчера: 'yesterday',
  yesterday: 'yesterday',
  завтра: 'tomorrow',
  tomorrow: 'tomorrow',
  'на этой неделе': 'this_week',
  'эта неделя': 'this_week',
  this_week: 'this_week',
  'на прошлой неделе': 'last_week',
  'прошлая неделя': 'last_week',
  last_week: 'last_week',
  'в этом месяце': 'this_month',
  'этот месяц': 'this_month',
  this_month: 'this_month',
  'в прошлом месяце': 'last_month',
  'прошлый месяц': 'last_month',
  last_month: 'last_month',
  'в этом квартале': 'this_quarter',
  'этот квартал': 'this_quarter',
  this_quarter: 'this_quarter',
  'в этом году': 'this_year',
  'этот год': 'this_year',
  this_year: 'this_year',
};

const CALENDAR_PERIODS: CalendarPeriod[] = [
  'today',
  'yesterday',
  'tomorrow',
  'this_week',
  'last_week',
  'this_month',
  'last_month',
  'this_quarter',
  'this_year',
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function compileFilter(criteria: Criterion[], options: CompileOptions): Promise<CompileResult> {
  if (!Array.isArray(criteria) || criteria.length === 0) {
    return { filter: '', used_fields: [], warnings: [] };
  }

  const used: UsedField[] = [];
  const warnings: string[] = [];
  const expressions: string[] = [];

  for (let criterion of criteria) {
    if (!criterion || typeof criterion.field !== 'string' || typeof criterion.op !== 'string') {
      throw new Error('Каждый critera должен быть объектом вида {field: string, op: string, value?: any}.');
    }

    const op = canonicalOp(criterion.op);
    const resolved = await resolveFieldPath(criterion.field, options);
    criterion = await substituteMe(criterion, resolved, options);

    // Lookup + текстовое значение → сравниваем с отображаемой колонкой справочника
    // (Type/Name), а не с FK-колонкой, куда текст всё равно не подставить.
    const byDisplayName = Boolean(resolved.displayPath) && isTextComparison(op, criterion);
    // uuid в lookup сравниваем через навигацию (Owner/Id): на тестовом стенде /$count и $count=true
    // падают на `OwnerId eq <uuid>`, а с навигацией работают. ne и пусто остаются на FK —
    // навигация отбросила бы записи с пустой связью.
    const byNavId = !byDisplayName && Boolean(resolved.idPath) && isUuidEquality(op, criterion);
    let path = resolved.path;
    if (byDisplayName) path = resolved.displayPath as string;
    else if (byNavId) path = resolved.idPath as string;
    // Пустота на FK (`AccountId eq null`, `OwnerId ne null`) на тестовом стенде рвёт поток даже без $count;
    // через навигацию работает и в выборке, и в /$count: `Account eq null`, `Owner/Id ne null`.
    else if (op === 'is_null' && resolved.idPath) path = resolved.idPath.replace(/\/Id$/, '');
    else if (op === 'is_not_null' && resolved.idPath) path = resolved.idPath;

    used.push({ input: criterion.field, resolved: path, caption: resolved.caption });
    // Текст и uuid сервер уже обработал сам — предупреждать не о чем.
    const uuidValue = typeof criterion.value === 'string' && UUID_RE.test(criterion.value);
    if (resolved.lookupWarning && !byDisplayName && !byNavId && !uuidValue && criterion.value !== undefined)
      warnings.push(resolved.lookupWarning);

    // `OwnerId ne <uuid>` на тестовом стенде рвёт поток, а `Owner/Id ne <uuid>` теряет записи без связи
    // (inner join). `not (Owner/Id eq <uuid>)` даёт верный результат и в выборке, и в /$count.
    if (
      op === 'ne' &&
      resolved.idPath &&
      typeof criterion.value === 'string' &&
      UUID_RE.test(criterion.value)
    ) {
      expressions.push(
        `not (${resolved.idPath} eq ${literalize(criterion.value, options.odataVersion, true)})`
      );
      continue;
    }

    const expr = buildExpression(
      path,
      op,
      criterion,
      options.odataVersion,
      resolved.isLookup && !byDisplayName,
      options.timeZone
    );
    expressions.push(expr);
  }

  const join = options.join === 'or' ? ' or ' : ' and ';
  // Wrap individual expressions in parens only when there's more than one,
  // to keep simple cases readable while preserving precedence.
  const filter = expressions.length === 1 ? expressions[0] : expressions.map((e) => `(${e})`).join(join);

  return { filter, used_fields: used, warnings };
}

/** «я»/@me в lookup на Contact или SysAdminUnit → Id текущего пользователя (и в списке для in). */
async function substituteMe(
  criterion: Criterion,
  resolved: ResolvedField,
  options: CompileOptions
): Promise<Criterion> {
  const values = Array.isArray(criterion.value) ? criterion.value : [criterion.value];
  if (!resolved.lookupCollection || !options.currentUser || !values.some(isMeMacro)) return criterion;

  const meId = meIdFor(resolved.lookupCollection, await options.currentUser.get());
  if (!meId) return criterion;
  const swap = (v: unknown) => (isMeMacro(v) ? meId : v);
  return {
    ...criterion,
    value: Array.isArray(criterion.value) ? criterion.value.map(swap) : swap(criterion.value),
  };
}

function isUuidEquality(op: CanonicalOp, criterion: Criterion): boolean {
  const isUuid = (v: unknown) => typeof v === 'string' && UUID_RE.test(v);
  if (op === 'eq') return isUuid(criterion.value);
  if (op === 'in') {
    return Array.isArray(criterion.value) && criterion.value.length > 0 && criterion.value.every(isUuid);
  }
  return false;
}

/**
 * Стоит ли сравнивать lookup с отображаемой колонкой справочника: значение —
 * текст, а не UUID, и оператор строковый. UUID и is_null остаются на FK-колонке.
 */
function isTextComparison(op: CanonicalOp, criterion: Criterion): boolean {
  if (CALENDAR_PERIODS.includes(op as CalendarPeriod)) return false;
  const textOps: CanonicalOp[] = [
    'eq',
    'ne',
    'contains',
    'not_contains',
    'startswith',
    'endswith',
    'similar_to',
    'in',
  ];
  if (!textOps.includes(op)) return false;

  const isText = (v: unknown) => typeof v === 'string' && v.length > 0 && !UUID_RE.test(v);

  if (op === 'in') {
    return Array.isArray(criterion.value) && criterion.value.length > 0 && criterion.value.every(isText);
  }
  return isText(criterion.value);
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
      `за последние N дней/in_last_days, за последние N часов/in_last_hours, между/between, ` +
      `похоже на/similar_to.`
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
  /** Путь к отображаемой колонке справочника ('City/Name') — для сравнения по тексту. */
  displayPath?: string;
  /** Справочник, на который ссылается последнее поле пути. */
  lookupCollection?: string;
  /** Путь к Id связанной записи через навигацию ('Owner/Id', только v4). */
  idPath?: string;
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
  let displayPath: string | undefined;
  let lookupCollection: string | undefined;
  let idPath: string | undefined;

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
        lookupCollection = lookupInfo.lookupCollection;
        lookupWarning =
          `Поле "${query}" является lookup; передайте UUID или используйте bpm_lookup_value для ` +
          `получения UUID по тексту.`;

        const meta = await options.metadataManager.getEntityMetadata(currentCollection);
        const prop = meta.properties.find((p) => p.name === fieldName);
        const nav =
          prop?.lookupNavProperty ??
          (options.odataVersion === 4 && fieldName.endsWith('Id') ? fieldName.slice(0, -2) : fieldName);
        const display =
          (await getDisplayColumn(options.metadataManager, lookupInfo.lookupCollection)) ??
          lookupInfo.displayColumn;
        if (isSafeIdentifier(nav) && isSafeIdentifier(display)) {
          displayPath = [...resolvedSegments.slice(0, -1), nav, display].join('/');
        }
        if (options.odataVersion === 4 && isSafeIdentifier(nav) && nav !== fieldName) {
          idPath = [...resolvedSegments.slice(0, -1), nav, 'Id'].join('/');
        }
      }
    }
  }

  return {
    path: resolvedSegments.join('/'),
    caption: firstCaption,
    isLookup,
    lookupWarning,
    displayPath,
    lookupCollection,
    idPath,
  };
}

function buildExpression(
  fieldPath: string,
  op: CanonicalOp,
  criterion: Criterion,
  odataVersion: 3 | 4,
  isLookup: boolean,
  timeZone?: string
): string {
  if (CALENDAR_PERIODS.includes(op as CalendarPeriod)) {
    // Полуинтервал [from, to): так последняя секунда суток не теряется.
    const range = calendarRange(op as CalendarPeriod, resolveTimeZone(timeZone));
    return (
      `${fieldPath} ge ${dateTimeLiteral(range.from, odataVersion)} and ` +
      `${fieldPath} lt ${dateTimeLiteral(range.to, odataVersion)}`
    );
  }

  switch (op) {
    case 'eq':
    case 'ne':
    case 'gt':
    case 'ge':
    case 'lt':
    case 'le': {
      // Дата без времени — это сутки в поясе пользователя, а не миг полуночи UTC.
      if (isDateOnly(criterion.value)) {
        const from = dateTimeLiteral(zonedInstant(criterion.value, timeZone), odataVersion);
        const to = dateTimeLiteral(nextDayStart(criterion.value, timeZone), odataVersion);
        if (op === 'eq') return `${fieldPath} ge ${from} and ${fieldPath} lt ${to}`;
        if (op === 'ne') return `(${fieldPath} lt ${from} or ${fieldPath} ge ${to})`;
        if (op === 'gt') return `${fieldPath} ge ${to}`;
        if (op === 'le') return `${fieldPath} lt ${to}`;
        return `${fieldPath} ${op} ${from}`;
      }
      return `${fieldPath} ${op} ${literalize(criterion.value, odataVersion, isLookup, timeZone)}`;
    }

    case 'contains':
      return containsExpression(fieldPath, String(criterion.value ?? ''), odataVersion, {
        caseInsensitive: true,
      });

    case 'not_contains':
      return `not ${containsExpression(fieldPath, String(criterion.value ?? ''), odataVersion, { caseInsensitive: true })}`;

    case 'similar_to':
      return containsExpression(fieldPath, normalizeName(String(criterion.value ?? '')).core, odataVersion, {
        caseInsensitive: true,
      });

    case 'startswith':
      return `startswith(${fieldPath}, ${stringLiteral(criterion.value)})`;

    case 'endswith':
      return `endswith(${fieldPath}, ${stringLiteral(criterion.value)})`;

    case 'in': {
      if (!Array.isArray(criterion.value) || criterion.value.length === 0) {
        throw new Error(`Оператор "in" требует value=массив с минимум одним элементом.`);
      }
      const parts = criterion.value.map(
        (v) => `${fieldPath} eq ${literalize(v, odataVersion, isLookup, timeZone)}`
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
      const lo = literalize(criterion.value, odataVersion, isLookup, timeZone);
      // «между 01.09 и 14.09» включает весь последний день.
      if (isDateOnly(criterion.value_to)) {
        const to = dateTimeLiteral(nextDayStart(criterion.value_to, timeZone), odataVersion);
        return `${fieldPath} ge ${lo} and ${fieldPath} lt ${to}`;
      }
      const hi = literalize(criterion.value_to, odataVersion, isLookup, timeZone);
      return `${fieldPath} ge ${lo} and ${fieldPath} le ${hi}`;
    }

    default:
      throw new Error(`Оператор "${op}" не поддерживается.`);
  }
}

function literalize(value: unknown, odataVersion: 3 | 4, isLookup: boolean, timeZone?: string): string {
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
      const d = zonedInstant(value, timeZone);
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

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function isDateOnly(value: unknown): value is string {
  return typeof value === 'string' && DATE_ONLY_RE.test(value);
}

/**
 * Дата/время без Z и смещения — местное время пользователя. `new Date()` взял бы
 * пояс процесса MCP (в Docker это UTC), и «15:00» уехало бы на три часа.
 */
function zonedInstant(value: string, timeZone?: string): Date {
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(value)) return new Date(value);
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?$/);
  if (!m) return new Date(value);
  const midnight = zonedMidnightUtc(Number(m[1]), Number(m[2]), Number(m[3]), resolveTimeZone(timeZone));
  // ponytail: смещение берётся на полночь; в день перевода часов время после перевода уедет на час.
  const offsetMs = ((Number(m[4] ?? 0) * 60 + Number(m[5] ?? 0)) * 60 + Number(m[6] ?? 0)) * 1000;
  return new Date(midnight.getTime() + offsetMs);
}

function nextDayStart(value: string, timeZone?: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return zonedMidnightUtc(year, month, day + 1, resolveTimeZone(timeZone));
}

function isIsoDateLike(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(value);
}
