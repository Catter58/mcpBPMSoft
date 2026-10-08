import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceContainer } from './init-tool.js';
import type { EntityProperty } from '../types/index.js';
import { BpmApiError, formatToolError } from '../utils/errors.js';
import type { CriterionNode } from '../utils/filter-compiler.js';
import { isNumericType } from '../utils/field-values.js';
import { canonicalCollection, canonicalField, presentRecords } from '../read/record-presentation.js';
import { aggregateRecords, findDuplicateGroups, type ResolvedMetric } from '../read/aggregation.js';
import { getTool } from './registry.js';
import { notInitialized, compileCriteria } from './_guards.js';
import { recordShape, criterionSchema } from './_schemas.js';
import { renderRecordsText } from '../utils/render.js';
import { createResolutionContext, type ResolutionContext } from '../lookup/resolution-context.js';
import {
  addDecimal,
  decimal,
  decimalText,
  compareDecimal,
  divideDecimal,
  multiplyDecimal,
  subtractDecimal,
} from '../utils/decimal.js';
import { bucketLabel, parseDateValue, type DateBucket } from '../utils/datetime.js';

const scanInputs = {
  collection: z.string().min(1).max(256),
  criteria: z.array(criterionSchema).max(100).optional(),
  join: z.enum(['and', 'or']).optional(),
  max_records: z
    .number()
    .int()
    .min(1)
    .max(20000)
    .optional()
    .describe('Предел серверного анализа, по умолчанию 5000. Неполный анализ явно помечается.'),
  max_groups: z.number().int().min(1).max(100).optional().describe('Предел групп ответа, по умолчанию 50.'),
};
const coverageShape = {
  success: z.literal(true),
  collection: z.string(),
  complete: z.boolean(),
  scanned_count: z.number().int(),
  total_count: z.number().int().optional(),
  has_more: z.boolean(),
  truncated_groups: z.boolean(),
  observed_group_count: z.number().int(),
  warnings: z.array(z.string()),
  field_labels: z.record(z.string(), z.string()),
};
interface ScanParams {
  collection: string;
  criteria?: CriterionNode[];
  join?: 'and' | 'or';
  max_records?: number;
  max_groups?: number;
  rank_by?: string;
  rank_direction?: 'asc' | 'desc';
  date_field?: string;
  bucket?: 'day' | 'week' | 'month' | 'year';
}

const comparisonInputs = {
  cohorts: z
    .array(
      z
        .object({
          label: z.string().trim().min(1).max(64),
          criteria: z.array(criterionSchema).max(100).optional(),
          join: z.enum(['and', 'or']).optional(),
        })
        .strict()
    )
    .min(2)
    .max(5)
    .optional()
    .describe(
      'Сравниваемые выборки одной коллекции, например baseline и new. Выборки могут пересекаться; counts учитывают каждую запись в каждом cohort.'
    ),
  compare: z
    .object({ baseline: z.string().trim().min(1).max(64), comparison: z.string().trim().min(1).max(64) })
    .strict()
    .optional()
    .describe(
      'Рассчитать разницу, процент изменения и процент от общей суммы cohort для sum-метрик между двумя метками cohorts.'
    ),
};

function failure(error: unknown, collection: string): CallToolResult {
  const result = formatToolError(error, collection);
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    structuredContent: result as unknown as Record<string, unknown>,
  };
}

function limit(value: number | undefined, fallback: number, ceiling: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > ceiling)
    throw new BpmApiError(`Параметр ${label} должен быть целым числом от 1 до ${ceiling}.`, 400);
  return result;
}

async function scan(
  services: ServiceContainer,
  collection: string,
  properties: EntityProperty[],
  params: ScanParams,
  resolutionContext?: ResolutionContext
) {
  const maximum = limit(params.max_records, 5000, 20000, 'max_records');
  const compiled = await compileCriteria(services, collection, params.criteria ?? [], params.join, {
    resolutionContext,
  });
  const response = await services.odataClient.getRecords<Record<string, unknown>>(
    collection,
    {
      $select: [...new Set(['Id', ...properties.map((property) => property.name)])].join(','),
      $filter: compiled.filter || undefined,
      $orderby: 'Id asc',
      $top: maximum + 1,
      $count: true,
    },
    true,
    maximum + 1
  );
  const records = response.value.slice(0, maximum);
  const total = response['@odata.count'];
  const hasMore =
    response.value.length > maximum ||
    !!response['@odata.nextLink'] ||
    (total !== undefined && total > records.length);
  const complete = !hasMore;
  const warnings = [...compiled.warnings, ...(response.warnings ?? [])];
  if (!complete)
    warnings.push(
      `Проанализированы только первые ${records.length} записей. Количество в группах и показатели относятся к этой выборке; полный итог неизвестен.`
    );
  return {
    records,
    complete,
    scanned_count: records.length,
    total_count: total,
    has_more: hasMore,
    warnings,
  };
}

function compareCohortGroups(
  cohortGroups: Array<{ label: string; groups: ReturnType<typeof aggregateRecords>; complete: boolean }>,
  metrics: ResolvedMetric[],
  comparison?: { baseline: string; comparison: string }
) {
  const keys = new Map<string, Record<string, unknown>>();
  const byLabel = new Map<string, Map<string, (typeof cohortGroups)[number]['groups'][number]>>();
  for (const cohort of cohortGroups) {
    const grouped = new Map(cohort.groups.map((group) => [JSON.stringify(group.dimensions), group]));
    byLabel.set(cohort.label, grouped);
    for (const group of cohort.groups) keys.set(JSON.stringify(group.dimensions), group.dimensions);
  }
  const totals = new Map<string, Map<string, string>>();
  if (comparison) {
    for (const metric of metrics) {
      if (metric.op !== 'sum') continue;
      let total = decimal(0);
      let sawValue = false;
      for (const cohort of cohortGroups) {
        const groups = byLabel.get(cohort.label)!;
        for (const group of groups.values()) {
          const value = group.metrics[metric.alias];
          if (value !== null) {
            total = addDecimal(total, decimal(value));
            sawValue = true;
          }
        }
        // Store each cohort total in a keyed form below.
        if (sawValue) {
          const cohortTotals = totals.get(cohort.label) ?? new Map<string, string>();
          cohortTotals.set(metric.alias, decimalText(total));
          totals.set(cohort.label, cohortTotals);
        }
        total = decimal(0);
        sawValue = false;
      }
    }
  }
  return [...keys.entries()].map(([key, dimensions]) => {
    const cohort_results = Object.fromEntries(
      cohortGroups.map((cohort) => {
        const group = byLabel.get(cohort.label)!.get(key);
        return [
          cohort.label,
          {
            count: group?.count ?? 0,
            metrics: group?.metrics ?? Object.fromEntries(metrics.map((metric) => [metric.alias, null])),
            metric_counts:
              group?.metric_counts ?? Object.fromEntries(metrics.map((metric) => [metric.alias, 0])),
          },
        ];
      })
    );
    let derived_metrics: Record<string, unknown> | undefined;
    if (comparison) {
      const base = byLabel.get(comparison.baseline)!;
      const comp = byLabel.get(comparison.comparison)!;
      const baseGroup = base.get(key);
      const compGroup = comp.get(key);
      derived_metrics = Object.fromEntries(
        metrics.map((metric) => {
          const baseline = baseGroup?.metrics[metric.alias] ?? null;
          const current = compGroup?.metrics[metric.alias] ?? null;
          const output: Record<string, string | null> = {
            difference: null,
            percent_change: null,
            baseline_share: null,
            comparison_share: null,
          };
          const reason: Record<string, string> = {};
          if (baseline === null || current === null) {
            reason.difference = 'missing_metric_value';
            reason.percent_change = 'missing_metric_value';
          } else {
            const before = decimal(baseline);
            const after = decimal(current);
            output.difference = decimalText(subtractDecimal(after, before));
            if (before.units === 0n) reason.percent_change = 'baseline_zero';
            else {
              const absolute = {
                units: before.units < 0n ? -before.units : before.units,
                scale: before.scale,
              };
              output.percent_change = decimalText(
                divideDecimal(multiplyDecimal(subtractDecimal(after, before), decimal(100)), absolute, 6)
              );
            }
          }
          if (metric.op !== 'sum') {
            reason.baseline_share = 'share_requires_sum_metric';
            reason.comparison_share = 'share_requires_sum_metric';
          } else {
            for (const [label, valueKey] of [
              [comparison.baseline, 'baseline_share'],
              [comparison.comparison, 'comparison_share'],
            ] as const) {
              const value = byLabel.get(label)!.get(key)?.metrics[metric.alias] ?? null;
              const denominator = totals.get(label)?.get(metric.alias);
              if (value === null || !denominator || decimal(denominator).units === 0n)
                reason[valueKey] = 'zero_or_missing_cohort_total';
              else
                output[valueKey] = decimalText(
                  divideDecimal(multiplyDecimal(decimal(value), decimal(100)), decimal(denominator), 6)
                );
            }
          }
          return [
            metric.alias,
            {
              ...output,
              partial: cohortGroups.some((cohort) => !cohort.complete),
              ...(Object.keys(reason).length ? { null_reasons: reason } : {}),
            },
          ];
        })
      );
    }
    return {
      dimensions,
      cohort_results,
      derived_metrics,
      count: cohortGroups.reduce((sum, c) => sum + (byLabel.get(c.label)!.get(key)?.count ?? 0), 0),
      metrics: {},
      metric_counts: {},
    };
  });
}

function rankGroups<
  T extends { dimensions: Record<string, unknown>; count: number; metrics: Record<string, string | null> },
>(groups: T[], rankBy: string | undefined, direction: 'asc' | 'desc' = 'desc'): T[] {
  if (!rankBy) return groups;
  return [...groups].sort((a, b) => {
    if (rankBy === 'count')
      return (
        (direction === 'asc' ? a.count - b.count : b.count - a.count) ||
        JSON.stringify(a.dimensions).localeCompare(JSON.stringify(b.dimensions))
      );
    const left = a.metrics[rankBy];
    const right = b.metrics[rankBy];
    if (left === null || left === undefined)
      return right === null || right === undefined
        ? JSON.stringify(a.dimensions).localeCompare(JSON.stringify(b.dimensions))
        : 1;
    if (right === null || right === undefined) return -1;
    const compared = compareDecimal(decimal(left), decimal(right));
    return (
      (direction === 'asc' ? compared : -compared) ||
      JSON.stringify(a.dimensions).localeCompare(JSON.stringify(b.dimensions))
    );
  });
}

async function fields(
  services: ServiceContainer,
  collection: string,
  queries: string[]
): Promise<EntityProperty[]> {
  const result: EntityProperty[] = [];
  for (const query of queries) {
    const property = await canonicalField(services, collection, query);
    if (['Edm.Binary', 'Edm.Stream'].includes(property.type) || property.type.startsWith('Collection('))
      throw new BpmApiError(
        `Поле ${property.name} нельзя использовать как ключ группировки.`,
        400,
        collection
      );
    if (result.some((field) => field.name === property.name))
      throw new BpmApiError(`Поле ${property.name} передано несколько раз.`, 400, collection);
    result.push(property);
  }
  return result;
}

export function registerAnalyticsTools(server: McpServer, services: ServiceContainer): void {
  const aggregate = getTool('bpm_aggregate_records');
  server.registerTool(
    aggregate.name,
    {
      title: aggregate.title,
      description: aggregate.description,
      annotations: aggregate.annotations,
      inputSchema: {
        ...scanInputs,
        ...comparisonInputs,
        rank_by: z.string().min(1).max(64).optional(),
        rank_direction: z.enum(['asc', 'desc']).optional(),
        date_field: z.string().min(1).max(256).optional(),
        bucket: z.enum(['day', 'week', 'month', 'year']).optional(),
        group_by: z.array(z.string().min(1).max(256)).max(5).optional(),
        metrics: z
          .array(
            z.object({
              field: z.string().min(1).max(256),
              op: z.enum(['sum', 'avg', 'min', 'max']),
              alias: z.string().min(1).max(64).optional(),
            })
          )
          .max(10)
          .optional(),
      },
      outputSchema: {
        ...coverageShape,
        ranking_scope: z.enum(['global', 'observed_scan']).optional(),
        bucket_field: z.string().optional(),
        cohort_coverage: z
          .array(
            z.object({
              label: z.string(),
              complete: z.boolean(),
              scanned_count: z.number().int(),
              total_count: z.number().int().optional(),
              has_more: z.boolean(),
            })
          )
          .optional(),
        comparison_unit: z.literal('cohort_membership').optional(),
        avg_precision: z.literal(6),
        numeric_encoding: z.literal('decimal_string'),
        groups: z.array(
          z.object({
            dimensions: recordShape,
            display_dimensions: recordShape,
            count: z.number().int(),
            metrics: z.record(z.string(), z.string().nullable()),
            metric_counts: z.record(z.string(), z.number().int()),
            cohort_results: z
              .record(
                z.string(),
                z.object({
                  count: z.number().int(),
                  metrics: z.record(z.string(), z.string().nullable()),
                  metric_counts: z.record(z.string(), z.number().int()),
                })
              )
              .optional(),
            derived_metrics: z
              .record(
                z.string(),
                z.object({
                  difference: z.string().nullable(),
                  percent_change: z.string().nullable(),
                  baseline_share: z.string().nullable(),
                  comparison_share: z.string().nullable(),
                  partial: z.boolean(),
                  null_reasons: z.record(z.string(), z.string()).optional(),
                })
              )
              .optional(),
          })
        ),
      },
    },
    async (params): Promise<CallToolResult> => {
      if (!services.initialized) return notInitialized();
      try {
        await services.authManager.ensureAuthenticated();
        const collection = await canonicalCollection(services, params.collection);
        const dimensions = await fields(services, collection, params.group_by ?? []);
        if (!!params.date_field !== !!params.bucket)
          throw new BpmApiError('date_field и bucket нужно передавать вместе.', 400, collection);
        let dateProperty: EntityProperty | undefined;
        let dateDimensionName: string | undefined;
        if (params.date_field) {
          dateProperty = await canonicalField(services, collection, params.date_field);
          if (!['Edm.Date', 'Edm.DateTime', 'Edm.DateTimeOffset'].includes(dateProperty.type))
            throw new BpmApiError(
              `Поле ${dateProperty.name} не является полем даты или времени.`,
              400,
              collection
            );
          if (dimensions.some((dimension) => dimension.name === dateProperty!.name))
            throw new BpmApiError('Поле date_field нельзя повторять в group_by.', 400, collection);
          dateDimensionName = `bucket_${dateProperty.name}`;
          const entityProperties = (await services.metadataManager.getEntityMetadata(collection)).properties;
          while (entityProperties.some((property) => property.name === dateDimensionName))
            dateDimensionName = `_${dateDimensionName}`;
        }
        const metrics: ResolvedMetric[] = [];
        for (const item of params.metrics ?? []) {
          const property = await canonicalField(services, collection, item.field);
          if (!isNumericType(property.type))
            throw new BpmApiError(
              `Поле ${property.name} (${property.type}) не является числовым.`,
              400,
              collection
            );
          const alias = item.alias ?? `${item.op}_${property.name}`;
          if (['__proto__', 'prototype', 'constructor'].includes(alias))
            throw new BpmApiError('Недопустимый псевдоним показателя.', 400, collection);
          if (metrics.some((metric) => metric.alias === alias))
            throw new BpmApiError(
              `Псевдоним показателя "${alias}" используется несколько раз.`,
              400,
              collection
            );
          metrics.push({ property, op: item.op, alias });
        }
        if (params.rank_direction && !params.rank_by)
          throw new BpmApiError('rank_direction требует rank_by.', 400, collection);
        if (
          params.rank_by &&
          params.rank_by !== 'count' &&
          !metrics.some((metric) => metric.alias === params.rank_by)
        )
          throw new BpmApiError(
            'rank_by должен быть count или псевдонимом объявленной метрики.',
            400,
            collection
          );
        if (params.cohorts && params.rank_by && params.rank_by !== 'count')
          throw new BpmApiError(
            'Ранжирование метрик с cohorts неоднозначно; используйте rank_by=count.',
            400,
            collection
          );
        let timezone: string | undefined;
        if (dateProperty && dateProperty.type !== 'Edm.Date') {
          try {
            timezone = (await createResolutionContext(services.currentUser).getTimeZone()).timeZone;
          } catch {
            throw new BpmApiError(
              'Для временной группировки нужен проверенный часовой пояс профиля или BPMSOFT_TIMEZONE.',
              400,
              collection
            );
          }
        }
        const dateDimension: EntityProperty | undefined =
          dateProperty && dateDimensionName
            ? { ...dateProperty, name: dateDimensionName, type: 'Edm.String', isLookup: false }
            : undefined;
        const groupingProperties = dateDimension ? [...dimensions, dateDimension] : dimensions;
        const withBuckets = (records: Array<Record<string, unknown>>) =>
          dateProperty && params.bucket
            ? records.map((record) => {
                const raw = record[dateProperty!.name];
                const parsed = parseDateValue(raw);
                return {
                  ...record,
                  [dateDimensionName!]:
                    parsed && !Number.isNaN(parsed.getTime())
                      ? bucketLabel(
                          parsed,
                          params.bucket as DateBucket,
                          dateProperty!.type === 'Edm.Date' ? 'UTC' : timezone!
                        )
                      : '(без даты)',
                };
              })
            : records;
        if (params.compare && !params.cohorts)
          throw new BpmApiError('compare требует cohorts.', 400, collection);
        if (params.compare && metrics.length === 0)
          throw new BpmApiError('compare требует хотя бы одну числовую метрику.', 400, collection);
        if (params.cohorts) {
          const labels = params.cohorts.map((cohort: { label: string }) => cohort.label);
          if (new Set(labels).size !== labels.length)
            throw new BpmApiError('Метки cohorts должны быть уникальными.', 400, collection);
          if (
            params.compare &&
            (params.compare.baseline === params.compare.comparison ||
              !labels.includes(params.compare.baseline) ||
              !labels.includes(params.compare.comparison))
          )
            throw new BpmApiError(
              'baseline и comparison должны указывать на разные существующие метки cohorts.',
              400,
              collection
            );
          const resolutionContext = createResolutionContext(services.currentUser);
          const cohortResults: Array<{
            label: string;
            groups: ReturnType<typeof aggregateRecords>;
            complete: boolean;
            scanned_count: number;
            total_count?: number;
            has_more: boolean;
            warnings: string[];
          }> = [];
          for (const cohort of params.cohorts as Array<{
            label: string;
            criteria?: CriterionNode[];
            join?: 'and' | 'or';
          }>) {
            const combined: CriterionNode[] = [];
            if (params.criteria?.length)
              combined.push(
                params.join === 'or'
                  ? { or: params.criteria as CriterionNode[] }
                  : { and: params.criteria as CriterionNode[] }
              );
            if (cohort.criteria?.length)
              combined.push(cohort.join === 'or' ? { or: cohort.criteria } : { and: cohort.criteria });
            const result = await scan(
              services,
              collection,
              dimensions.concat(
                dateProperty ? [dateProperty] : [],
                metrics.map((metric) => metric.property)
              ),
              {
                ...(params as ScanParams),
                criteria: combined,
                join: 'and',
              },
              resolutionContext
            );
            cohortResults.push({
              label: cohort.label,
              groups: aggregateRecords(withBuckets(result.records), groupingProperties, metrics, collection),
              complete: result.complete,
              scanned_count: result.scanned_count,
              total_count: result.total_count,
              has_more: result.has_more,
              warnings: result.warnings,
            });
          }
          const complete = cohortResults.every((cohort) => cohort.complete);
          const allGroups = rankGroups(
            compareCohortGroups(cohortResults, metrics, params.compare),
            params.rank_by,
            params.rank_direction
          );
          const maximumGroups = limit(params.max_groups, 50, 100, 'max_groups');
          const chosen = allGroups.slice(0, maximumGroups);
          const presentation = await presentRecords(
            services,
            collection,
            chosen.map((group) => group.dimensions)
          );
          if (dateDimensionName && params.bucket)
            presentation.fieldLabels[dateDimensionName] =
              `${presentation.fieldLabels[dateProperty!.name] ?? dateProperty!.name} (${params.bucket})`;
          const groups = chosen.map((group, index) => ({
            ...group,
            display_dimensions: presentation.displayRecords[index],
          }));
          const warnings = cohortResults.flatMap((cohort) => cohort.warnings).concat(presentation.warnings);
          if (!complete)
            warnings.push(
              'Одна или несколько выборок неполны; сравнения и доли рассчитаны только по просмотренным записям.'
            );
          const scannedCount = cohortResults.reduce((sum, cohort) => sum + cohort.scanned_count, 0);
          const totalsKnown = cohortResults.every((cohort) => cohort.total_count !== undefined);
          const totalCount = totalsKnown
            ? cohortResults.reduce((sum, cohort) => sum + cohort.total_count!, 0)
            : undefined;
          const payload = {
            success: true as const,
            collection,
            complete,
            scanned_count: scannedCount,
            total_count: totalCount,
            comparison_unit: 'cohort_membership' as const,
            ranking_scope: params.rank_by
              ? complete
                ? ('global' as const)
                : ('observed_scan' as const)
              : undefined,
            bucket_field: dateDimensionName,
            has_more: cohortResults.some((cohort) => cohort.has_more),
            truncated_groups: allGroups.length > groups.length,
            observed_group_count: allGroups.length,
            cohort_coverage: cohortResults.map(
              ({ label, complete: isComplete, scanned_count, total_count, has_more }) => ({
                label,
                complete: isComplete,
                scanned_count,
                total_count,
                has_more,
              })
            ),
            avg_precision: 6 as const,
            numeric_encoding: 'decimal_string' as const,
            groups,
            field_labels: presentation.fieldLabels,
            warnings,
          };
          const text = [
            `Сравнение ${collection}: ${cohortResults.map((cohort) => `${cohort.label} — ${cohort.scanned_count}${cohort.total_count !== undefined ? ` из ${cohort.total_count}` : ''}`).join('; ')}. Счётчики суммируют членства в cohorts, поэтому пересекающиеся выборки учитывают запись в каждой метке. ${complete ? 'Все выборки полные.' : 'Есть частичная выборка.'}`,
            ...warnings,
            renderRecordsText(
              groups.map((group) => ({
                ...group.display_dimensions,
                cohort_results: group.cohort_results,
                derived_metrics: group.derived_metrics,
              })),
              { collection, format: 'markdown' }
            ),
            payload.truncated_groups
              ? `Показаны ${groups.length} из ${allGroups.length} наблюдаемых групп.`
              : '',
          ]
            .filter(Boolean)
            .join('\n\n');
          return { content: [{ type: 'text', text }], structuredContent: payload };
        }
        const result = await scan(
          services,
          collection,
          dimensions.concat(
            dateProperty ? [dateProperty] : [],
            metrics.map((metric) => metric.property)
          ),
          params
        );
        const allGroups = rankGroups(
          aggregateRecords(withBuckets(result.records), groupingProperties, metrics, collection),
          params.rank_by,
          params.rank_direction
        );
        const maximumGroups = limit(params.max_groups, 50, 100, 'max_groups');
        const chosen = allGroups.slice(0, maximumGroups);
        const presentation = await presentRecords(
          services,
          collection,
          chosen.map((group) => group.dimensions)
        );
        if (dateDimensionName && params.bucket)
          presentation.fieldLabels[dateDimensionName] =
            `${presentation.fieldLabels[dateProperty!.name] ?? dateProperty!.name} (${params.bucket})`;
        const groups = chosen.map((group, index) => ({
          ...group,
          display_dimensions: presentation.displayRecords[index],
        }));
        const payload = {
          success: true as const,
          collection,
          ranking_scope: params.rank_by
            ? result.complete
              ? ('global' as const)
              : ('observed_scan' as const)
            : undefined,
          bucket_field: dateDimensionName,
          complete: result.complete,
          scanned_count: result.scanned_count,
          total_count: result.total_count,
          has_more: result.has_more,
          truncated_groups: allGroups.length > groups.length,
          observed_group_count: allGroups.length,
          avg_precision: 6 as const,
          numeric_encoding: 'decimal_string' as const,
          groups,
          field_labels: presentation.fieldLabels,
          warnings: result.warnings.concat(presentation.warnings),
        };
        const table = groups.map((group) => ({
          ...group.display_dimensions,
          Количество: group.count,
          ...group.metrics,
        }));
        const text = [
          `Анализ ${collection}: ${result.scanned_count}${result.total_count !== undefined ? ` из ${result.total_count}` : ''} записей. ${result.complete ? 'Выборка полная.' : 'Частичная выборка.'}`,
          ...payload.warnings,
          renderRecordsText(table, { collection, format: 'markdown' }),
          payload.truncated_groups
            ? `Показаны ${groups.length} из ${allGroups.length} наблюдаемых групп.`
            : '',
        ]
          .filter(Boolean)
          .join('\n\n');
        return { content: [{ type: 'text', text }], structuredContent: payload };
      } catch (error) {
        return failure(error, params.collection);
      }
    }
  );
}

export const duplicateFieldsOutputShape = {
  ...coverageShape,
  fields: z.array(z.string()),
  observed_duplicate_records: z.number().int(),
  groups: z.array(
    z.object({
      normalized_key: recordShape,
      dimensions: recordShape,
      display_dimensions: recordShape,
      count: z.number().int(),
      record_ids: z.array(z.string()),
      record_ids_truncated: z.boolean(),
      sample_records: z.array(recordShape),
    })
  ),
};

export async function findDuplicatesByFields(
  services: ServiceContainer,
  params: ScanParams & { fields?: string[] }
): Promise<CallToolResult> {
  if (!services.initialized) return notInitialized();
  try {
    await services.authManager.ensureAuthenticated();
    const collection = await canonicalCollection(services, params.collection);
    const keyFields = await fields(services, collection, params.fields ?? ['Name']);
    if (!keyFields.length)
      throw new BpmApiError('Для проверки дублей нужно хотя бы одно поле.', 400, collection);
    const result = await scan(services, collection, keyFields, params);
    const allGroups = findDuplicateGroups(result.records, keyFields, collection);
    const chosen = allGroups.slice(0, limit(params.max_groups, 50, 100, 'max_groups'));
    const presentation = await presentRecords(
      services,
      collection,
      chosen.map((group) => group.dimensions)
    );
    const groups = chosen.map((group, index) => ({
      ...group,
      display_dimensions: presentation.displayRecords[index],
      record_ids_truncated: group.record_ids.length < group.count,
    }));
    const payload = {
      success: true as const,
      collection,
      fields: keyFields.map((field) => field.name),
      complete: result.complete,
      scanned_count: result.scanned_count,
      total_count: result.total_count,
      has_more: result.has_more,
      truncated_groups: allGroups.length > groups.length,
      observed_group_count: allGroups.length,
      observed_duplicate_records: allGroups.reduce((sum, group) => sum + group.count, 0),
      groups,
      field_labels: presentation.fieldLabels,
      warnings: result.warnings.concat(presentation.warnings, [
        'Группы содержат кандидатов на дубли. Совпадение нормализованного ключа требует проверки перед объединением.',
      ]),
    };
    const table = groups.map((group) => ({
      ...group.display_dimensions,
      Количество: group.count,
      'Примеры UUID': group.record_ids.slice(0, 5).join(', '),
    }));
    return {
      content: [
        {
          type: 'text',
          text: [
            `Проверка дублей ${collection}: ${result.scanned_count} записей, ${allGroups.length} групп кандидатов.`,
            ...payload.warnings,
            renderRecordsText(table, { collection, format: 'markdown' }),
          ].join('\n\n'),
        },
      ],
      structuredContent: payload,
    };
  } catch (error) {
    return failure(error, params.collection);
  }
}
