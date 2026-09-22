/**
 * MCP Tool: bpm_aggregate
 *
 * Группировка и суммы на стороне сервера. `$apply=groupby` на части стендов
 * рвёт поток (тестовый стенд), а выгружать тысячи записей в контекст модели, чтобы она
 * посчитала их «в уме», дорого и ненадёжно. Сервер сам листает страницы,
 * выбирая только нужные колонки, группирует и подставляет имена групп.
 *
 * Временные интервалы (bucket), календарный период (period) и сравнение с
 * предыдущим периодом (compare_previous) считаются в поясе пользователя —
 * вопрос «эта неделя против прошлой по дням» закрывается одним вызовом.
 */

import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceContainer } from './init-tool.js';
import { formatToolError, UnknownFieldError } from '../utils/errors.js';
import { getTool } from './registry.js';
import { notInitialized, resolveCollectionName, compileCriteria, combineFilters } from './_guards.js';
import { criterionSchema } from './_schemas.js';
import { getRecordsWithLookupNames, displayKeyFor } from '../utils/display.js';
import type { Criterion } from '../utils/filter-compiler.js';
import {
  bucketLabel,
  bucketLabelsInRange,
  calendarRange,
  previousPeriodRange,
  resolveTimeZone,
  zonedParts,
  type CalendarPeriod,
  type DateRange,
} from '../utils/datetime.js';

const PAGE_SIZE = 1000;
const EMPTY_GUID = '00000000-0000-0000-0000-000000000000';
const DEFAULT_MAX_RECORDS = 10000;
const MAX_RECORDS_CAP = 50000;
const METRIC_OPS = ['count', 'sum', 'avg', 'min', 'max'] as const;
const BUCKETS = ['day', 'week', 'month', 'quarter', 'year'] as const;
export const NO_DATE_BUCKET = '(без даты)';
type MetricOp = (typeof METRIC_OPS)[number];

// ponytail: копия календарной части OP_ALIASES из filter-compiler (там не экспортируется).
const PERIOD_ALIASES: Record<string, CalendarPeriod> = {
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

interface Metric {
  op: MetricOp;
  field?: string;
  label: string;
}

interface GroupAcc {
  key: string | null;
  label: string;
  bucket?: string;
  count: number;
  sums: Map<string, number>;
  counts: Map<string, number>;
  mins: Map<string, number>;
  maxs: Map<string, number>;
}

export interface Delta {
  count: number;
  count_pct: number | null;
}

export interface AggregateGroup {
  key: string | null;
  label: string;
  bucket?: string;
  count: number;
  metrics: Record<string, number | null>;
  previous_count?: number;
  previous_metrics?: Record<string, number | null>;
  delta?: Delta;
}

export function registerAggregateTool(server: McpServer, services: ServiceContainer): void {
  const meta = getTool('bpm_aggregate');
  const rangeSchema = z.object({ from: z.string(), to: z.string() });
  server.registerTool(
    meta.name,
    {
      title: meta.title,
      description: meta.description,
      inputSchema: {
        collection: z.string().describe('Имя коллекции (EntitySet) или её русское название'),
        criteria: z.array(criterionSchema).optional().describe('Условие отбора, как в bpm_search_records'),
        join: z.enum(['and', 'or']).optional().describe('Как соединять criteria: and (по умолчанию) или or'),
        filter: z.string().optional().describe('OData $filter (объединяется с criteria через and)'),
        group_by: z
          .string()
          .optional()
          .describe(
            'Поле группировки (имя или подпись). Для lookup группы подписаны именами. Без него — итог по всем'
          ),
        metrics: z
          .array(
            z.object({
              op: z.enum(METRIC_OPS).describe('count, sum, avg, min, max'),
              field: z.string().optional().describe('Числовое поле (для sum/avg/min/max)'),
            })
          )
          .optional()
          .describe('Что считать; count есть всегда'),
        date_field: z
          .string()
          .optional()
          .describe('Поле даты (имя или подпись) для bucket и period, например StartDate или «Создан»'),
        bucket: z
          .enum(BUCKETS)
          .optional()
          .describe(
            'Группировка по времени в поясе пользователя: day, week (с понедельника), month, quarter, year'
          ),
        period: z
          .string()
          .optional()
          .describe(
            'Календарный период по date_field: сегодня, вчера, на этой неделе, на прошлой неделе, в этом месяце, ' +
              'в прошлом месяце, в этом квартале, в этом году (или today, this_week, last_month...)'
          ),
        compare_previous: z
          .boolean()
          .optional()
          .describe('Посчитать и предыдущий период той же длины (нужен period): previous_count и delta'),
        max_records: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            `Сколько записей максимум просмотреть (по умолчанию ${DEFAULT_MAX_RECORDS}, потолок ${MAX_RECORDS_CAP})`
          ),
      },
      outputSchema: {
        collection: z.string(),
        filter: z.string().optional(),
        group_by: z.string().optional(),
        date_field: z.string().optional(),
        bucket: z.string().optional(),
        timezone: z.string().optional(),
        period: rangeSchema.optional(),
        previous_period: rangeSchema.optional(),
        scanned: z.number().int(),
        truncated: z.boolean(),
        groups: z.array(
          z.object({
            key: z.string().nullable(),
            label: z.string(),
            bucket: z.string().optional(),
            count: z.number().int(),
            metrics: z.record(z.string(), z.number().nullable()),
            previous_count: z.number().int().optional(),
            previous_metrics: z.record(z.string(), z.number().nullable()).optional(),
            delta: z.object({ count: z.number().int(), count_pct: z.number().nullable() }).optional(),
          })
        ),
      },
      annotations: meta.annotations,
    },
    async (params): Promise<CallToolResult> => {
      if (!services.initialized) return notInitialized();
      try {
        if ((params.bucket || params.period) && !params.date_field) {
          throw new Error('Для bucket и period нужно поле даты (date_field), например StartDate.');
        }
        if (params.compare_previous && !params.period) {
          throw new Error('compare_previous работает только вместе с period (например, «на этой неделе»).');
        }
        const period = params.period ? parsePeriod(params.period) : undefined;

        await services.authManager.ensureAuthenticated();
        const collection = await resolveCollectionName(services, params.collection);

        const compiled = params.criteria?.length
          ? await compileCriteria(services, collection, params.criteria as Criterion[], params.join)
          : undefined;
        const filter = combineFilters(params.filter, compiled?.filter);

        const resolveField = async (query: string): Promise<string> => {
          const ref = await services.metadataManager.resolveFieldReference(collection, query);
          if (ref.name === null) throw new UnknownFieldError(query, collection, ref.suggestions);
          return ref.name;
        };

        const groupField = params.group_by ? await resolveField(params.group_by) : undefined;
        const dateField = params.date_field ? await resolveField(params.date_field) : undefined;
        const metrics: Metric[] = [];
        for (const m of params.metrics ?? []) {
          if (m.op === 'count') continue;
          if (!m.field) throw new Error(`Метрике ${m.op} нужно поле (field).`);
          const field = await resolveField(m.field);
          metrics.push({ op: m.op, field, label: `${m.op}(${field})` });
        }

        let timeZone: string | undefined;
        if (dateField) {
          let userZone: string | undefined;
          try {
            userZone = (await services.currentUser.get()).timeZoneId || undefined;
          } catch {
            // DataService недоступен — считаем в поясе сервера.
          }
          timeZone = resolveTimeZone(userZone);
        }
        const zone = timeZone as string;
        const now = new Date();
        const range = period ? calendarRange(period, zone, now) : undefined;
        const previousRange =
          period && params.compare_previous ? previousPeriodRange(period, zone, now) : undefined;

        const columns = new Set(['Id']);
        if (groupField) columns.add(groupField);
        if (dateField) columns.add(dateField);
        for (const m of metrics) if (m.field) columns.add(m.field);

        const maxRecords = Math.min(params.max_records ?? DEFAULT_MAX_RECORDS, MAX_RECORDS_CAP);
        const deps = {
          metadataManager: services.metadataManager,
          odataClient: services.odataClient,
          odataVersion: services.config.odata_version,
        };
        const labelKey = groupField ? displayKeyFor(groupField) : undefined;
        const bucketOf = (record: Record<string, unknown>): string | undefined => {
          if (!params.bucket || !dateField) return undefined;
          const date = parseDateValue(record[dateField]);
          return date ? bucketLabel(date, params.bucket, zone) : NO_DATE_BUCKET;
        };

        // Постранично через $skip: серверный nextLink есть не на всех стендах.
        // max_records действует на каждый просматриваемый период отдельно.
        const scan = async (pageFilter: string | undefined) => {
          const groups = new Map<string, GroupAcc>();
          let scanned = 0;
          let truncated = false;
          while (scanned < maxRecords) {
            const pageSize = Math.min(PAGE_SIZE, maxRecords - scanned);
            const { records } = await getRecordsWithLookupNames(
              deps,
              collection,
              {
                $filter: pageFilter,
                $select: [...columns].join(','),
                $top: pageSize,
                $skip: scanned,
                $orderby: 'Id',
              },
              { resolveLookups: Boolean(groupField) }
            );
            for (const record of records) {
              accumulate(groups, record, groupField, labelKey, metrics, bucketOf(record));
            }
            scanned += records.length;
            if (records.length < pageSize) break;
            if (scanned >= maxRecords) truncated = true;
          }
          return { groups, scanned, truncated };
        };

        const version = services.config.odata_version;
        const rangeFilter = (r: DateRange) =>
          `${dateField} ge ${dateLiteral(r.from, version)} and ${dateField} lt ${dateLiteral(r.to, version)}`;
        const effectiveFilter = range ? combineFilters(filter, rangeFilter(range)) : filter;

        const current = await scan(effectiveFilter);
        const previous = previousRange
          ? await scan(combineFilters(filter, rangeFilter(previousRange)))
          : undefined;

        // Интервалы предыдущего периода сопоставляются с текущими по порядку: понедельник с понедельником.
        let align: ((bucket: string | undefined) => string | undefined) | undefined;
        if (previous && params.bucket && range && previousRange) {
          const currentLabels = bucketLabelsInRange(range, params.bucket, zone);
          const before = bucketLabelsInRange(previousRange, params.bucket, zone);
          const map = new Map(before.map((label, i) => [label, currentLabels[i] ?? label]));
          align = (bucket) => (bucket === undefined ? undefined : (map.get(bucket) ?? bucket));
        }

        const result = buildGroups(current.groups, previous?.groups, metrics, align);
        const scanned = current.scanned + (previous?.scanned ?? 0);
        const truncated = current.truncated || Boolean(previous?.truncated);

        const header =
          `Агрегация ${collection}${effectiveFilter ? ` (условие: ${effectiveFilter})` : ''}: ` +
          `просмотрено ${scanned} записей` +
          (truncated ? ` — достигнут лимит max_records=${maxRecords}, итоги неполные` : '');
        const lines = [
          header,
          ...(groupField ? [`Группировка: ${groupField}`] : []),
          ...(params.bucket ? [`Интервал: ${params.bucket} по ${dateField} (пояс ${zone})`] : []),
          ...(range ? [`Период: ${describeRange(range, zone)}`] : []),
          ...(previousRange ? [`Предыдущий период: ${describeRange(previousRange, zone)}`] : []),
          '',
          ...result.map((g) => formatGroupLine(g, metrics, Boolean(groupField))),
        ];

        const iso = (r: DateRange) => ({ from: r.from.toISOString(), to: r.to.toISOString() });
        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: {
            collection,
            filter: effectiveFilter,
            group_by: groupField,
            date_field: dateField,
            bucket: params.bucket,
            timezone: timeZone,
            period: range ? iso(range) : undefined,
            previous_period: previousRange ? iso(previousRange) : undefined,
            scanned,
            truncated,
            groups: result,
          },
        };
      } catch (error) {
        const toolError = formatToolError(error, params.collection);
        return { content: [{ type: 'text', text: JSON.stringify(toolError, null, 2) }], isError: true };
      }
    }
  );
}

function parsePeriod(input: string): CalendarPeriod {
  const period = PERIOD_ALIASES[input.trim().toLowerCase()];
  if (period) return period;
  throw new Error(
    `Неизвестный период: "${input}". Допустимые: сегодня, вчера, завтра, на этой неделе, на прошлой неделе, ` +
      'в этом месяце, в прошлом месяце, в этом квартале, в этом году (или today, this_week, last_month...).'
  );
}

/** Литерал даты как в filter-compiler: ISO с Z для v4, datetime'...' для v3. */
function dateLiteral(date: Date, odataVersion: 3 | 4): string {
  const iso = date.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return odataVersion === 3 ? `datetime'${iso.replace(/Z$/, '')}'` : iso;
}

/** Значение даты из ответа: ISO-строка (v4) или /Date(ms)/ (v3); пустое и мусор — null. */
export function parseDateValue(raw: unknown): Date | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const legacy = typeof raw === 'string' ? /^\/Date\((-?\d+)/.exec(raw) : null;
  const date = legacy ? new Date(Number(legacy[1])) : new Date(raw as string);
  return Number.isNaN(date.getTime()) ? null : date;
}

function describeRange(range: DateRange, timeZone: string): string {
  const day = (d: Date) => {
    const p = zonedParts(d, timeZone);
    return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  };
  return `${day(range.from)} — ${day(new Date(range.to.getTime() - 1))}`;
}

const groupMapKey = (bucket: string | undefined, key: string | null) => `${bucket ?? ''} ${key ?? ' empty'}`;

/** Добавляет запись в её группу (интервал × значение group_by) и копит метрики; нечисловые и пустые пропускаются. */
export function accumulate(
  groups: Map<string, GroupAcc>,
  record: Record<string, unknown>,
  groupField: string | undefined,
  labelKey: string | undefined,
  metrics: Metric[],
  bucket?: string
): void {
  const raw = groupField ? record[groupField] : null;
  // Пустая связь в BPMSoft — это нулевой guid, а не null.
  const key = raw === null || raw === undefined || raw === '' || raw === EMPTY_GUID ? null : String(raw);
  const mapKey = groupMapKey(bucket, key);
  let group = groups.get(mapKey);
  if (!group) {
    const named = labelKey ? record[labelKey] : undefined;
    const label = !groupField ? 'Всего' : key === null ? '(пусто)' : String(named || key);
    group = emptyGroup(key, label, bucket);
    groups.set(mapKey, group);
  }
  group.count += 1;
  for (const m of metrics) {
    const rawValue = record[m.field as string];
    const value = Number(rawValue);
    if (rawValue === null || rawValue === undefined || rawValue === '' || !Number.isFinite(value)) continue;
    group.sums.set(m.label, (group.sums.get(m.label) ?? 0) + value);
    group.counts.set(m.label, (group.counts.get(m.label) ?? 0) + 1);
    group.mins.set(m.label, Math.min(group.mins.get(m.label) ?? value, value));
    group.maxs.set(m.label, Math.max(group.maxs.get(m.label) ?? value, value));
  }
}

function emptyGroup(key: string | null, label: string, bucket: string | undefined): GroupAcc {
  return {
    key,
    label,
    bucket,
    count: 0,
    sums: new Map(),
    counts: new Map(),
    mins: new Map(),
    maxs: new Map(),
  };
}

/** Изменение к предыдущему периоду; процент округлён до десятых, при нуле «было» — null. */
export function computeDelta(count: number, previousCount: number): Delta {
  const diff = count - previousCount;
  return {
    count: diff,
    count_pct: previousCount === 0 ? null : Math.round((diff / previousCount) * 1000) / 10,
  };
}

/**
 * Итоговые группы: при сравнении группы, которые были только в предыдущем периоде,
 * тоже попадают в ответ (count 0). Сортировка: интервал по возрастанию, «без даты» в конце,
 * затем count по убыванию.
 */
export function buildGroups(
  current: Map<string, GroupAcc>,
  previous: Map<string, GroupAcc> | undefined,
  metrics: Metric[],
  align: (bucket: string | undefined) => string | undefined = (b) => b
): AggregateGroup[] {
  const values = (g: GroupAcc) => Object.fromEntries(metrics.map((m) => [m.label, metricValue(g, m)]));
  const pairs = new Map<string, { now: GroupAcc; before?: GroupAcc }>();
  for (const [mapKey, g] of current) pairs.set(mapKey, { now: g });
  for (const g of previous?.values() ?? []) {
    const bucket = align(g.bucket);
    const mapKey = groupMapKey(bucket, g.key);
    const pair = pairs.get(mapKey) ?? { now: emptyGroup(g.key, g.label, bucket) };
    pair.before = g;
    pairs.set(mapKey, pair);
  }

  return [...pairs.values()]
    .sort((a, b) => compareBuckets(a.now.bucket, b.now.bucket) || b.now.count - a.now.count)
    .map(({ now, before }) => {
      const group: AggregateGroup = {
        key: now.key,
        label: now.label,
        ...(now.bucket !== undefined ? { bucket: now.bucket } : {}),
        count: now.count,
        metrics: values(now),
      };
      if (!previous) return group;
      const was = before ?? emptyGroup(now.key, now.label, now.bucket);
      return {
        ...group,
        previous_count: was.count,
        previous_metrics: values(was),
        delta: computeDelta(now.count, was.count),
      };
    });
}

function compareBuckets(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0;
  if (a === NO_DATE_BUCKET) return 1;
  if (b === NO_DATE_BUCKET) return -1;
  return (a ?? '') < (b ?? '') ? -1 : 1;
}

function formatGroupLine(g: AggregateGroup, metrics: Metric[], grouped: boolean): string {
  const name = [g.bucket, grouped || g.bucket === undefined ? g.label : undefined]
    .filter(Boolean)
    .join(' · ');
  const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
  const count =
    g.delta && g.previous_count !== undefined
      ? `${g.previous_count} → ${g.count} (${signed(g.delta.count)}` +
        `${g.delta.count_pct === null ? '' : `, ${signed(g.delta.count_pct)}%`})`
      : String(g.count);
  const metricText = metrics
    .map((m) => {
      const value = `${g.metrics[m.label] ?? '—'}`;
      return g.previous_metrics
        ? `, ${m.label}: ${g.previous_metrics[m.label] ?? '—'} → ${value}`
        : `, ${m.label}=${value}`;
    })
    .join('');
  return `  - ${name}: ${count}${metricText}`;
}

function metricValue(group: GroupAcc, metric: Metric): number | null {
  const n = group.counts.get(metric.label) ?? 0;
  if (n === 0) return null;
  if (metric.op === 'sum') return group.sums.get(metric.label) ?? null;
  if (metric.op === 'avg') return (group.sums.get(metric.label) ?? 0) / n;
  if (metric.op === 'min') return group.mins.get(metric.label) ?? null;
  return group.maxs.get(metric.label) ?? null;
}
