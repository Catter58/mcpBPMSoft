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
 * Metadata owns scalar types; LookupResolver owns reference identity.
 */

import { getDisplayColumn } from './display.js';
import { calendarRange, resolveTimeZone, zonedMidnightUtc, type CalendarPeriod } from './datetime.js';
import { isMeMacro, meIdFor } from './me-macro.js';
import { coerceValue, needsTimeZone } from './coerce.js';
import type { CurrentUser } from '../user/current-user.js';
import type { MetadataManager } from '../metadata/metadata-manager.js';
import type { LookupResolver } from '../lookup/lookup-resolver.js';
import type { ResolutionContext } from '../lookup/resolution-context.js';
import type { EntityProperty } from '../types/index.js';
import { BpmApiError, LookupResolutionError, UnknownFieldError } from './errors.js';
import { containsExpression, escapeODataString, isSafeIdentifier } from './odata.js';
import { normalizeName } from './name-normalize.js';
import {
  coerceFieldValue,
  fieldValueError,
  isDateType,
  isNumericType,
  literalizeFieldValue,
  UUID_RE,
} from './field-values.js';

export interface Criterion {
  /** Field name, caption ("Город") or navigation path ("Account.City"). */
  field?: string;
  /** Operator — Russian synonym or canonical OData op. */
  op: string;
  /** Right-hand value. Optional for is_null / is_not_null. */
  value?: unknown;
  /** Upper bound for `between`. */
  value_to?: unknown;
}

/** Bounded boolean groups accepted alongside the legacy flat leaf array. */
export type CriterionNode =
  | Criterion
  | { and: CriterionNode[] }
  | { or: CriterionNode[] }
  | { not: CriterionNode };

export interface CompileOptions {
  collection: string;
  metadataManager: MetadataManager;
  odataVersion: 3 | 4;
  lookupResolver?: Pick<LookupResolver, 'resolve'>;
  timeZone?: string;
  currentUser?: { get(): Promise<CurrentUser> };
  resolutionContext?: ResolutionContext;
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
  | 'not_contains'
  | 'similar_to'
  | 'exists'
  | 'not_exists'
  | StateOp
  | CalendarPeriod;

/** Состояние записи по признакам справочника статуса/стадии (End, IsFinal, Successful…). */
type StateOp = 'state_open' | 'state_closed' | 'state_won' | 'state_lost';

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
  exists: 'exists',
  not_exists: 'not_exists',
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
  // состояние по признакам справочника статуса (Stage/End, Status/IsFinal…)
  открыт: 'state_open',
  открыта: 'state_open',
  открыто: 'state_open',
  открытые: 'state_open',
  open: 'state_open',
  active: 'state_open',
  закрыт: 'state_closed',
  закрыта: 'state_closed',
  закрыто: 'state_closed',
  закрытые: 'state_closed',
  завершён: 'state_closed',
  завершен: 'state_closed',
  завершена: 'state_closed',
  closed: 'state_closed',
  final: 'state_closed',
  успешно: 'state_won',
  успешна: 'state_won',
  успешные: 'state_won',
  выиграна: 'state_won',
  won: 'state_won',
  successful: 'state_won',
  неуспешно: 'state_lost',
  проиграна: 'state_lost',
  lost: 'state_lost',
};

const STATE_OPS: StateOp[] = ['state_open', 'state_closed', 'state_won', 'state_lost'];
/** Поле не указано или указано обобщённо — ищем справочник статуса сами. */
const STATE_FIELD_ALIASES = ['', 'состояние', 'state'];
/** Признак «запись в конечном состоянии» — по приоритету. */
const FINAL_FLAGS = ['End', 'FinalStatus', 'IsFinal', 'Finish'];
/** Признак успешного исхода — по приоритету. */
const SUCCESS_FLAGS = ['Successful', 'IsResolved'];
/** Обратный признак: Active=false — закрыт (LeadStatus). */
const ACTIVE_FLAG = 'Active';

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

const MAX_CRITERIA_NODES = 100;
const MAX_CRITERIA_DEPTH = 8;

export async function compileFilter(
  criteria: CriterionNode[],
  options: CompileOptions
): Promise<CompileResult> {
  if (!Array.isArray(criteria))
    throw new BpmApiError('criteria должен быть массивом условий.', 400, options.collection);
  if (criteria.length === 0) {
    return { filter: '', used_fields: [], warnings: [] };
  }

  let nodeCount = 0;
  const compileNode = async (node: CriterionNode, depth: number): Promise<string> => {
    nodeCount++;
    if (nodeCount > MAX_CRITERIA_NODES)
      throw new BpmApiError(`criteria содержит больше ${MAX_CRITERIA_NODES} узлов.`, 400, options.collection);
    if (depth > MAX_CRITERIA_DEPTH)
      throw new BpmApiError(
        `Вложенность criteria не должна превышать ${MAX_CRITERIA_DEPTH}.`,
        400,
        options.collection
      );
    if (!node || typeof node !== 'object' || Array.isArray(node))
      throw new BpmApiError(
        'Каждый элемент criteria должен быть условием или логической группой.',
        400,
        options.collection
      );
    const keys = Object.keys(node);
    const groupKey = ['and', 'or', 'not'].find((key) => Object.hasOwn(node, key));
    if (groupKey) {
      if (keys.length !== 1)
        throw new BpmApiError(
          'Логическая группа должна содержать только один из and/or/not.',
          400,
          options.collection
        );
      if (groupKey === 'not')
        return `(not (${await compileNode((node as { not: CriterionNode }).not, depth + 1)}))`;
      const children =
        groupKey === 'and' ? (node as { and: CriterionNode[] }).and : (node as { or: CriterionNode[] }).or;
      if (!Array.isArray(children) || children.length === 0)
        throw new BpmApiError(
          `Группа ${groupKey} должна содержать непустой массив.`,
          400,
          options.collection
        );
      const separator = groupKey === 'and' ? ' and ' : ' or ';
      const parts: string[] = [];
      for (const child of children) parts.push(await compileNode(child, depth + 1));
      return `(${parts.map((part) => `(${part})`).join(separator)})`;
    }
    if (keys.some((key) => !['field', 'op', 'value', 'value_to'].includes(key)))
      throw new BpmApiError('Критерий содержит неизвестные свойства.', 400, options.collection);
    return compileLeaf(node as Criterion);
  };
  const used: UsedField[] = [];
  const warnings: string[] = [];
  const compileLeaf = async (criterionInput: Criterion): Promise<string> => {
    let criterion = criterionInput;
    if (!criterion || typeof criterion.op !== 'string') {
      throw new BpmApiError(
        'Каждый criterion должен быть объектом вида {field: string, op: string, value?: any}.',
        400,
        options.collection
      );
    }

    const op = canonicalOp(criterion.op);
    if (op === 'exists' || op === 'not_exists') {
      if (
        typeof criterion.field !== 'string' ||
        !criterion.field.trim() ||
        criterion.value !== undefined ||
        criterion.value_to !== undefined
      )
        throw new BpmApiError(
          `Оператор ${op} требует только field с именем коллекционной навигации.`,
          400,
          options.collection
        );
      if (options.odataVersion !== 4)
        throw new BpmApiError(
          'Проверка наличия связанной коллекции поддерживается только в OData v4.',
          400,
          options.collection
        );
      const nav = criterion.field.trim();
      if (!isSafeIdentifier(nav))
        throw new BpmApiError(
          'Имя коллекционной навигации должно быть точным безопасным идентификатором из $metadata.',
          400,
          options.collection
        );
      const navigation = await options.metadataManager.getCollectionNavigationInfo(options.collection, nav);
      if (!navigation)
        throw new BpmApiError(
          `Коллекционная навигация "${nav}" не подтверждена метаданными; укажите точное имя навигации из $metadata.`,
          400,
          options.collection
        );
      const targetMetadata = await options.metadataManager.getEntityMetadata(navigation.targetCollection);
      const targetKey = targetMetadata.keyFields?.find((key) => {
        if (!isSafeIdentifier(key)) return false;
        const property = targetMetadata.properties.find((item) => item.name === key);
        return property !== undefined && property.nullable === false;
      });
      if (!targetKey)
        throw new BpmApiError(
          `Невозможно проверить наличие связанной коллекции "${nav}": у целевой коллекции "${navigation.targetCollection}" нет подтверждённого безопасного обязательного ключевого поля в $metadata.`,
          400,
          options.collection
        );
      used.push({ input: criterion.field, resolved: nav });
      const predicate = `${nav}/any(related: related/${targetKey} ne null)`;
      return op === 'exists' ? predicate : `not (${predicate})`;
    }
    if (STATE_OPS.includes(op as StateOp)) {
      const state = await compileState(criterion, op as StateOp, options);
      used.push(state.used);
      warnings.push(state.note);
      return state.expr;
    }
    if (typeof criterion.field !== 'string')
      throw new BpmApiError('Укажите field в условии.', 400, options.collection);
    const reference = await resolveFieldPath(criterion.field, options);
    const leafOptions = { ...options };
    const dateValues = [
      ...(Array.isArray(criterion.value) ? criterion.value : [criterion.value]),
      criterion.value_to,
    ];
    const needsContext =
      isDateType(reference.property.type) &&
      op !== 'is_null' &&
      op !== 'is_not_null' &&
      (CALENDAR_PERIODS.includes(op as CalendarPeriod) ||
        ((op === 'in_last_days' || op === 'in_last_hours') && reference.property.type === 'Edm.Date') ||
        dateValues.some((value) => needsTimeZone(value, reference.property.type)) ||
        (reference.property.type === 'Edm.Date' && dateValues.some((value) => value instanceof Date)));
    if (needsContext && options.resolutionContext) {
      leafOptions.timeZone = (await options.resolutionContext.getTimeZone()).timeZone;
    }
    criterion = await substituteMe(criterion, reference, leafOptions);
    const resolved = await resolveExpressionField(reference, op, leafOptions, criterion);

    used.push({
      input: criterion.field ?? reference.path,
      resolved: resolved.path,
      caption: resolved.caption,
    });
    const expr = await buildExpression(resolved, op, criterion, leafOptions);
    return expr;
  };

  const expressions: string[] = [];
  for (const criterion of criteria) expressions.push(await compileNode(criterion, 0));

  const join = options.join === 'or' ? ' or ' : ' and ';
  // Wrap individual expressions in parens only when there's more than one,
  // to keep simple cases readable while preserving precedence.
  const filter = expressions.length === 1 ? expressions[0] : expressions.map((e) => `(${e})`).join(join);

  return { filter, used_fields: used, warnings };
}

/**
 * «открыт»/«закрыт»/«выиграна»/«проиграна» → фильтр по признакам справочника статуса:
 * `Stage/End eq false`, `(Stage/End eq true and Stage/Successful eq true)` и т.п.
 * Только навигационная форма: FK-формы на тестовом стенде рвут поток.
 */
async function compileState(
  criterion: Criterion,
  op: StateOp,
  options: CompileOptions
): Promise<{ expr: string; used: UsedField; note: string }> {
  const input = typeof criterion.field === 'string' ? criterion.field.trim() : '';
  const resolved = STATE_FIELD_ALIASES.includes(input.toLowerCase())
    ? await resolveFieldPath(await detectStateField(options), options)
    : await resolveFieldPath(input, options);
  const nav = resolved.displayPath?.replace(/\/[^/]+$/, '') ?? resolved.idPath?.replace(/\/Id$/, '');
  if (!resolved.lookupCollection || !nav) {
    throw new Error(
      `Оператор "${criterion.op}" применим только к справочнику статуса или стадии, ` +
        `а поле "${input}" (${resolved.path}) — не справочник.`
    );
  }

  const target = await options.metadataManager.getEntityMetadata(resolved.lookupCollection);
  const booleans = new Set(target.properties.filter((p) => /bool/i.test(p.type)).map((p) => p.name));
  const finalFlag = FINAL_FLAGS.find((f) => booleans.has(f));
  const successFlag = SUCCESS_FLAGS.find((f) => booleans.has(f));
  const where = `справочник ${resolved.lookupCollection} (поле ${nav})`;
  if (!finalFlag && !booleans.has(ACTIVE_FLAG)) {
    throw new Error(
      `Не удалось определить «${criterion.op}»: ${where} не содержит признака завершённости — ` +
        `искали логические колонки ${FINAL_FLAGS.join(', ')} или ${ACTIVE_FLAG}. ` +
        `Отфильтруйте по названию статуса: {field: "${nav}", op: "в списке", value: ["…", "…"]}.`
    );
  }

  const isFinal = finalFlag ? `${nav}/${finalFlag} eq true` : `${nav}/${ACTIVE_FLAG} eq false`;
  const notFinal = finalFlag ? `${nav}/${finalFlag} eq false` : `${nav}/${ACTIVE_FLAG} eq true`;
  let expr: string;
  if (op === 'state_open') {
    // Пустой статус — запись не закрыта. `Nav eq null` (v4), а не `Nav/Id eq null` — та теряет записи.
    const empty = options.odataVersion === 4 ? `${nav} eq null` : `${resolved.path} eq null`;
    expr = `(${empty} or ${notFinal})`;
  } else if (op === 'state_closed') {
    expr = isFinal;
  } else {
    if (!successFlag) {
      throw new Error(
        `Не удалось определить «${criterion.op}»: ${where} не содержит признака успеха — ` +
          `искали логические колонки ${SUCCESS_FLAGS.join(', ')}. Доступно только «открыт»/«закрыт»; ` +
          `исход отфильтруйте по названию статуса: {field: "${nav}", op: "в списке", value: ["…"]}.`
      );
    }
    expr = `(${isFinal} and ${nav}/${successFlag} eq ${op === 'state_won'})`;
  }

  return {
    expr,
    used: { input: input || 'состояние', resolved: nav, caption: resolved.caption },
    note: `«${criterion.op}» → ${expr} (справочник ${resolved.lookupCollection}).`,
  };
}

/**
 * Справочник состояния коллекции: lookup с Status/Stage/State в имени. Точные Stage/Status/State
 * (у Lead — QualifyStatus) выигрывают; иначе единственный кандидат с признаком завершённости.
 */
async function detectStateField(options: CompileOptions): Promise<string> {
  const meta = await options.metadataManager.getEntityMetadata(options.collection);
  const candidates = meta.properties.filter(
    (p) => p.isLookup && p.lookupCollection && /Status|Stage|State/i.test(p.name)
  );
  const base = (name: string) => name.replace(/Id$/, '');
  const preferred = [...(options.collection === 'Lead' ? ['QualifyStatus'] : []), 'Stage', 'Status', 'State'];
  for (const name of preferred) {
    const hit = candidates.find((p) => base(p.name) === name);
    if (hit) return hit.name;
  }
  if (candidates.length === 1) return candidates[0].name;

  const flagged: string[] = [];
  for (const p of candidates) {
    const target = await options.metadataManager.getEntityMetadata(p.lookupCollection as string);
    const flags = [...FINAL_FLAGS, ACTIVE_FLAG];
    if (target.properties.some((t) => flags.includes(t.name) && /bool/i.test(t.type))) flagged.push(p.name);
  }
  if (flagged.length === 1) return flagged[0];
  if (candidates.length === 0) {
    throw new Error(
      `В ${options.collection} не найдено поле статуса/стадии (lookup с Status/Stage/State в имени). ` +
        `Укажите field явно.`
    );
  }
  const list = (flagged.length > 1 ? flagged : candidates.map((p) => p.name)).join(', ');
  throw new Error(`В ${options.collection} несколько полей состояния: ${list}. Укажите field явно.`);
}

/** «я»/@me в lookup на Contact или SysAdminUnit → Id текущего пользователя (и в списке для in). */
async function substituteMe(
  criterion: Criterion,
  resolved: ResolvedField,
  options: CompileOptions
): Promise<Criterion> {
  const values = Array.isArray(criterion.value) ? criterion.value : [criterion.value];
  if (
    !resolved.lookupCollection ||
    (!options.currentUser && !options.resolutionContext) ||
    !values.some(isMeMacro)
  )
    return criterion;

  const user = options.resolutionContext
    ? await options.resolutionContext.getCurrentUser()
    : await options.currentUser!.get();
  const meId = meIdFor(resolved.lookupCollection, user);
  if (!meId) return criterion;
  const swap = (v: unknown) => (isMeMacro(v) ? meId : v);
  return {
    ...criterion,
    value: Array.isArray(criterion.value) ? criterion.value.map(swap) : swap(criterion.value),
  };
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

  throw new BpmApiError(
    `Неизвестный оператор: "${input}". Допустимые: равно/eq, не равно/ne, больше/gt, ` +
      `больше или равно/ge, меньше/lt, меньше или равно/le, содержит/contains, ` +
      `не содержит/not_contains, начинается с/startswith, заканчивается на/endswith, ` +
      `в списке/in, пусто/is_null, не пусто/is_not_null, ` +
      `за последние N дней/in_last_days, за последние N часов/in_last_hours, между/between, ` +
      `похоже на/similar_to.`,
    400
  );
}

export interface ResolvedField {
  path: string;
  caption?: string;
  property: EntityProperty;
  collection: string;
  isLookup: boolean;
  displayPath?: string;
  idPath?: string;
  lookupCollection?: string;
  lookup?: { lookupCollection: string; displayColumn: string; navigationProperty?: string };
}

export async function resolveFieldPath(query: string, options: CompileOptions): Promise<ResolvedField> {
  const segments = query.split(/[./]/).map((s) => s.trim());
  if (segments.some((segment) => !segment))
    throw new BpmApiError(`Пустой сегмент пути поля: "${query}".`, 400, options.collection);
  let currentCollection = options.collection;
  const resolvedSegments: string[] = [];
  let caption: string | undefined;
  for (let i = 0; i < segments.length; i++) {
    const ref = await options.metadataManager.resolveFieldReference(currentCollection, segments[i]);
    if (ref.name === null) throw new UnknownFieldError(query, currentCollection, ref.suggestions);
    const fieldName = ref.name;
    if (!isSafeIdentifier(fieldName))
      throw new BpmApiError(`Небезопасное имя поля: "${fieldName}".`, 400, currentCollection);
    const meta = await options.metadataManager.getEntityMetadata(currentCollection);
    const property = meta.properties.find((p) => p.name === fieldName);
    if (!property) throw new UnknownFieldError(query, currentCollection, []);
    if (i === 0) caption = property.caption;
    const lookup = await options.metadataManager.getLookupInfo(currentCollection, fieldName);
    if (i === segments.length - 1) {
      resolvedSegments.push(fieldName);
      const nav =
        lookup?.navigationProperty ||
        property.lookupNavProperty ||
        (options.odataVersion === 4 ? fieldName.replace(/Id$/, '') : fieldName);
      const display = lookup
        ? ((await getDisplayColumn(options.metadataManager, lookup.lookupCollection)) ?? lookup.displayColumn)
        : undefined;
      let idPath: string | undefined;
      if (lookup && options.odataVersion === 4 && nav !== fieldName && isSafeIdentifier(nav)) {
        const target = await options.metadataManager.getEntityMetadata(lookup.lookupCollection);
        const keys = target.keyFields?.length
          ? target.keyFields
          : target.properties.some((p) => p.name === 'Id' && p.type === 'Edm.Guid')
            ? ['Id']
            : [];
        const key =
          keys.length === 1
            ? target.properties.find((p) => p.name === keys[0] && p.type === 'Edm.Guid')
            : undefined;
        if (!key || !isSafeIdentifier(key.name))
          throw fieldValueError(
            property,
            'справочник не описывает однозначный UUID-ключ.',
            currentCollection
          );
        idPath = [...resolvedSegments.slice(0, -1), nav, key.name].join('/');
      }
      return {
        path: resolvedSegments.join('/'),
        isLookup: !!lookup,
        lookupCollection: lookup?.lookupCollection,
        displayPath:
          lookup && display && isSafeIdentifier(nav) && isSafeIdentifier(display)
            ? [...resolvedSegments.slice(0, -1), nav, display].join('/')
            : undefined,
        idPath,
        caption,
        property,
        collection: currentCollection,
        lookup: lookup ?? undefined,
      };
    }
    if (!lookup)
      throw new UnknownFieldError(query, currentCollection, [
        `Сегмент "${segments[i]}" не является ссылкой на справочник.`,
      ]);
    const nav =
      lookup.navigationProperty ||
      property.lookupNavProperty ||
      (options.odataVersion === 4 ? fieldName.replace(/Id$/, '') : fieldName);
    if (!isSafeIdentifier(nav))
      throw new BpmApiError(`Небезопасное имя навигации: "${nav}".`, 400, currentCollection);
    resolvedSegments.push(nav);
    currentCollection = lookup.lookupCollection;
  }
  throw new UnknownFieldError(query, options.collection, []);
}

async function resolveExpressionField(
  field: ResolvedField,
  op: CanonicalOp,
  options: CompileOptions,
  criterion: Criterion
): Promise<ResolvedField> {
  let { path, property } = field;
  const stringOps = ['contains', 'not_contains', 'similar_to', 'startswith', 'endswith'];
  const values = Array.isArray(criterion.value) ? criterion.value : [criterion.value];
  const displayEquality =
    !options.lookupResolver &&
    ['eq', 'ne', 'in'].includes(op) &&
    values.length > 0 &&
    values.every((v) => typeof v === 'string' && !UUID_RE.test(v.trim()));
  if ((stringOps.includes(op) || displayEquality) && field.lookup) {
    const target = await options.metadataManager.getEntityMetadata(field.lookup.lookupCollection);
    const displayName = field.displayPath?.split('/').pop() ?? field.lookup.displayColumn;
    const display = target.properties.find((p) => p.name === displayName);
    if (!display || !field.displayPath)
      throw fieldValueError(property, 'отображаемое поле справочника недоступно.', field.collection);
    path = field.displayPath;
    property = display;
    return { ...field, path, property, lookup: undefined };
  }
  if (field.idPath && ['eq', 'ne', 'in', 'is_not_null'].includes(op)) path = field.idPath;
  if (field.idPath && op === 'is_null') path = field.idPath.split('/').slice(0, -1).join('/');
  return { ...field, path, property };
}

async function buildExpression(
  field: ResolvedField,
  op: CanonicalOp,
  criterion: Criterion,
  options: CompileOptions
): Promise<string> {
  const { path, property } = field;
  const stringOps = ['contains', 'not_contains', 'similar_to', 'startswith', 'endswith'];
  if (stringOps.includes(op) && property.type !== 'Edm.String')
    throw fieldValueError(property, `оператор "${op}" допустим только для строк.`, field.collection);
  if ([...CALENDAR_PERIODS, 'in_last_days', 'in_last_hours'].includes(op) && !isDateType(property.type))
    throw fieldValueError(property, `оператор "${op}" допустим только для дат.`, field.collection);
  if (
    ['gt', 'ge', 'lt', 'le', 'between'].includes(op) &&
    !isDateType(property.type) &&
    !isNumericType(property.type) &&
    property.type !== 'Edm.String'
  )
    throw fieldValueError(property, `оператор "${op}" не поддерживается этим типом.`, field.collection);
  const literal = async (value: unknown): Promise<string> => {
    if (field.lookup && !stringOps.includes(op) && typeof value === 'string' && !UUID_RE.test(value.trim())) {
      if (!options.lookupResolver)
        throw fieldValueError(property, 'для поиска по названию требуется LookupResolver.', field.collection);
      const result = await options.lookupResolver.resolve(
        field.lookup.lookupCollection,
        value,
        field.lookup.displayColumn,
        { fuzzy: true }
      );
      if (!result.resolved || !result.id)
        throw new LookupResolutionError(
          criterion.field ?? field.path,
          value,
          result.matchCount,
          result.candidates,
          field.lookup
        );
      value = result.id;
    }
    if (property.type === 'Edm.Date' && value instanceof Date) {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: resolveTimeZone(options.timeZone),
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(value);
      const part = (type: string) => parts.find((p) => p.type === type)?.value;
      value = `${part('year')}-${part('month')}-${part('day')}`;
    }
    if (isDateType(property.type))
      value = coerceValue(property.name, value, property.type, options.timeZone, {
        ...(options.resolutionContext ? { now: options.resolutionContext.now } : {}),
        ...(isDateOnly(value) ? { defaultHour: 0 } : {}),
      }).value;
    return literalizeFieldValue(value, property, options.odataVersion, field.collection);
  };
  const stringValue = (): string => {
    const value = coerceFieldValue(criterion.value, property, field.collection);
    if (typeof value !== 'string')
      throw fieldValueError(
        property,
        'оператор поиска по тексту требует строковое значение.',
        field.collection
      );
    return value;
  };
  if (CALENDAR_PERIODS.includes(op as CalendarPeriod)) {
    const range = calendarRange(
      op as CalendarPeriod,
      resolveTimeZone(options.timeZone),
      options.resolutionContext?.now
    );
    return `${path} ge ${await literal(range.from)} and ${path} lt ${await literal(range.to)}`;
  }
  switch (op) {
    case 'eq':
    case 'ne':
    case 'gt':
    case 'ge':
    case 'lt':
    case 'le': {
      if (isDateType(property.type) && property.type !== 'Edm.Date' && isDateOnly(criterion.value)) {
        const from = await literal(criterion.value);
        const to = await literal(nextDayStart(criterion.value, options.timeZone));
        if (op === 'eq') return `${path} ge ${from} and ${path} lt ${to}`;
        if (op === 'ne') return `(${path} lt ${from} or ${path} ge ${to})`;
        if (op === 'gt') return `${path} ge ${to}`;
        if (op === 'le') return `${path} lt ${to}`;
        return `${path} ${op} ${from}`;
      }
      if (op === 'ne' && field.idPath && criterion.value !== null)
        return `not (${path} eq ${await literal(criterion.value)})`;
      return `${path} ${op} ${await literal(criterion.value)}`;
    }
    case 'contains':
    case 'not_contains':
    case 'similar_to': {
      const value = stringValue();
      const needle = op === 'similar_to' ? normalizeName(value).core : value.toLowerCase();
      const expression = containsExpression(path, needle, options.odataVersion, { caseInsensitive: true });
      return op === 'not_contains' ? `not ${expression}` : expression;
    }
    case 'startswith':
    case 'endswith':
      return `${op}(${path}, '${escapeODataString(stringValue())}')`;
    case 'in': {
      if (!Array.isArray(criterion.value) || criterion.value.length === 0)
        throw fieldValueError(property, 'оператор in требует непустой массив.', field.collection);
      const parts: string[] = [];
      for (const value of criterion.value) parts.push(`${path} eq ${await literal(value)}`);
      return parts.length === 1 ? parts[0] : `(${parts.join(' or ')})`;
    }
    case 'is_null':
      return `${path} eq null`;
    case 'is_not_null':
      return `${path} ne null`;
    case 'in_last_days':
    case 'in_last_hours': {
      const amount = numericValue(criterion.value, op);
      const since = new Date(
        (options.resolutionContext?.now.getTime() ?? Date.now()) -
          amount * (op === 'in_last_days' ? 86400000 : 3600000)
      );
      return `${path} ge ${await literal(since)}`;
    }
    case 'between': {
      if (criterion.value === undefined || criterion.value_to === undefined)
        throw fieldValueError(property, 'оператор between требует обе границы.', field.collection);
      if (isDateType(property.type) && property.type !== 'Edm.Date' && isDateOnly(criterion.value_to))
        return `${path} ge ${await literal(criterion.value)} and ${path} lt ${await literal(nextDayStart(criterion.value_to, options.timeZone))}`;
      return `${path} ge ${await literal(criterion.value)} and ${path} le ${await literal(criterion.value_to)}`;
    }
    default:
      throw new BpmApiError(`Оператор "${op}" не поддерживается.`, 400, field.collection);
  }
}

function numericValue(value: unknown, op: CanonicalOp): number {
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value.trim())
        ? Number(value)
        : NaN;
  if (Number.isSafeInteger(number) && number > 0) return number;
  throw new BpmApiError(`Оператор "${op}" требует value=положительное целое число.`, 400);
}

function isDateOnly(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}
function nextDayStart(value: string, timeZone?: string): Date {
  // Validate the original calendar date before adding a day (invalid dates must not normalize).
  coerceFieldValue(value, { name: 'date', type: 'Edm.Date', nullable: false, isLookup: false });
  const [year, month, day] = value.split('-').map(Number);
  return zonedMidnightUtc(year, month, day + 1, resolveTimeZone(timeZone));
}
