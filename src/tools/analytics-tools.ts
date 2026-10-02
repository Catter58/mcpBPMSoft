import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceContainer } from './init-tool.js';
import type { EntityProperty } from '../types/index.js';
import { BpmApiError, formatToolError } from '../utils/errors.js';
import type { Criterion } from '../utils/filter-compiler.js';
import { isNumericType } from '../utils/field-values.js';
import { canonicalCollection, canonicalField, presentRecords } from '../read/record-presentation.js';
import { aggregateRecords, findDuplicateGroups, type ResolvedMetric } from '../read/aggregation.js';
import { getTool } from './registry.js';
import { notInitialized, compileCriteria } from './_guards.js';
import { recordShape, criterionSchema } from './_schemas.js';
import { renderRecordsText } from '../utils/render.js';

const scanInputs = {
  collection: z.string().min(1).max(256),
  criteria: z.array(criterionSchema).max(50).optional(),
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
  criteria?: Criterion[];
  join?: 'and' | 'or';
  max_records?: number;
  max_groups?: number;
}

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
  params: ScanParams
) {
  const maximum = limit(params.max_records, 5000, 20000, 'max_records');
  const compiled = await compileCriteria(services, collection, params.criteria ?? [], params.join);
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
        avg_precision: z.literal(6),
        numeric_encoding: z.literal('decimal_string'),
        groups: z.array(
          z.object({
            dimensions: recordShape,
            display_dimensions: recordShape,
            count: z.number().int(),
            metrics: z.record(z.string(), z.string().nullable()),
            metric_counts: z.record(z.string(), z.number().int()),
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
        const result = await scan(
          services,
          collection,
          dimensions.concat(metrics.map((metric) => metric.property)),
          params
        );
        const allGroups = aggregateRecords(result.records, dimensions, metrics, collection);
        const maximumGroups = limit(params.max_groups, 50, 100, 'max_groups');
        const chosen = allGroups.slice(0, maximumGroups);
        const presentation = await presentRecords(
          services,
          collection,
          chosen.map((group) => group.dimensions)
        );
        const groups = chosen.map((group, index) => ({
          ...group,
          display_dimensions: presentation.displayRecords[index],
        }));
        const payload = {
          success: true as const,
          collection,
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
