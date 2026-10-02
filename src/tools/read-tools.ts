import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceContainer } from './init-tool.js';
import { formatToolError, BpmApiError } from '../utils/errors.js';
import { getTool } from './registry.js';
import {
  notInitialized,
  resolveRecordId,
  resolveCollection,
  compileCriteria,
  combineFilters,
} from './_guards.js';
import {
  resolveSelect,
  resolveOrderBy,
  getRecordsWithLookupNames,
  getRecordWithLookupNames,
  enrichLookups,
  planLookupExpand,
} from '../utils/display.js';
import { type Criterion } from '../utils/filter-compiler.js';
import { renderRecordsText, type RenderFormat } from '../utils/render.js';
import { decodeCursor, buildNextCursor, type CursorState } from '../utils/cursor.js';
import { getAuthCacheScope } from '../auth/request-context.js';
import { paginationShape, recordShape, criterionSchema } from './_schemas.js';
import { canonicalCollection, readSelect, presentRecords } from '../read/record-presentation.js';
import { registerAnalyticsTools } from './analytics-tools.js';
import { compactRecord } from '../utils/compact.js';

const DEFAULT_TOP = 20;
const DEFAULT_MAX_RECORDS = 1000;
const RESPONSE_BUDGET = 512 * 1024;
const formats = ['compact', 'full', 'markdown'] as const;

const pageInputs = {
  collection: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe('Коллекция или её русская подпись. Не нужна при cursor.'),
  select: z
    .string()
    .max(8192)
    .optional()
    .describe(
      'Поля через запятую; поддерживаются русские подписи. По умолчанию только основные поля, * — все небинарные.'
    ),
  orderby: z
    .string()
    .max(2048)
    .optional()
    .describe('Сортировка, например Имя asc; Id обеспечивает стабильный порядок'),
  top: z.number().int().min(1).max(1000).optional().describe('Размер страницы, по умолчанию 20'),
  skip: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  expand: z
    .string()
    .max(8192)
    .optional()
    .describe('Дополнительное OData $expand; справочные названия сервер уже возвращает автоматически'),
  count: z.boolean().optional().describe('Получить достоверное total_count по всем совпадениям'),
  auto_paginate: z.boolean().optional().describe('Явно дочитать несколько страниц в пределах max_records'),
  max_records: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe('Потолок записей ответа, по умолчанию 1000'),
  format: z.enum(formats).optional().describe('compact (по умолчанию), markdown или full'),
  resolve_lookups: z
    .boolean()
    .optional()
    .describe('Добавлять названия связей; совместимый параметр resolve_references.'),
  dry_run: z.boolean().optional().describe('Вернуть собранный запрос без чтения записей.'),
  resolve_references: z
    .boolean()
    .optional()
    .describe('Возвращать названия связанных записей (по умолчанию true)'),
  cursor: z
    .string()
    .max(65536)
    .optional()
    .describe('Продолжение предыдущего ответа; остальные параметры поиска наследуются'),
};

const presentationShape = {
  display_records: z.array(recordShape),
  field_labels: z.record(z.string(), z.string()),
  warnings: z.array(z.string()),
};

type PageParams = {
  collection?: string;
  select?: string;
  orderby?: string;
  top?: number;
  skip?: number;
  expand?: string;
  count?: boolean;
  auto_paginate?: boolean;
  max_records?: number;
  format?: RenderFormat;
  resolve_references?: boolean;
  resolve_lookups?: boolean;
  dry_run?: boolean;
  cursor?: string;
  filter?: string;
  criteria?: Criterion[];
  join?: 'and' | 'or';
};

function errorResult(error: unknown, collection?: string): CallToolResult {
  const failure = formatToolError(error, collection);
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(failure, null, 2) }],
    structuredContent: failure as unknown as Record<string, unknown>,
  };
}

async function selectForRead(
  services: ServiceContainer,
  collection: string,
  select: string | undefined,
  warnings: string[]
): Promise<string | undefined> {
  if (select?.trim() === '*') return readSelect(services, collection, '*');
  const resolved = await resolveSelect(services.metadataManager, collection, select, warnings);
  return resolved ? readSelect(services, collection, resolved) : undefined;
}

async function listRecords(
  services: ServiceContainer,
  params: PageParams,
  search: boolean
): Promise<CallToolResult> {
  if (!services.initialized) return notInitialized();
  try {
    await services.authManager.ensureAuthenticated();
    if (
      params.resolve_references !== undefined &&
      params.resolve_lookups !== undefined &&
      params.resolve_references !== params.resolve_lookups
    )
      throw new BpmApiError('resolve_references и resolve_lookups заданы противоречиво.', 400);
    const resolveReferences = params.resolve_references ?? params.resolve_lookups ?? true;
    const scope = `${services.config.bpmsoft_url}:${getAuthCacheScope() || services.config.username || ''}:records`;
    let state: CursorState;
    let usedFields: Array<{ input: string; resolved: string; caption?: string }> = [];
    const warnings: string[] = [];
    if (params.cursor) state = decodeCursor(params.cursor, scope);
    else {
      if (!params.collection) throw new BpmApiError('Передайте collection или cursor', 400);
      const resolvedCollection = await resolveCollection(services, params.collection, { autoCorrect: true });
      const collection = resolvedCollection.name;
      if (resolvedCollection.note) warnings.push(resolvedCollection.note);
      let filter = params.filter;
      if (search) {
        if (!params.criteria) throw new BpmApiError('Передайте criteria или cursor', 400);
        const compiled = await compileCriteria(services, collection, params.criteria, params.join, {
          autoCorrect: true,
        });
        filter = compiled.filter || undefined;
        usedFields = compiled.used_fields;
        warnings.push(...compiled.warnings);
      }
      state = {
        v: 1,
        collection,
        filter,
        select: await selectForRead(services, collection, params.select, warnings),
        orderby:
          (await resolveOrderBy(services.metadataManager, collection, params.orderby, warnings)) ?? 'Id asc',
        expand: params.expand,
        count: params.count,
        top: params.top ?? DEFAULT_TOP,
        skip: params.skip ?? 0,
      };
    }
    const limit = params.auto_paginate
      ? (params.max_records ?? DEFAULT_MAX_RECORDS)
      : Math.min(state.top ?? DEFAULT_TOP, params.max_records ?? DEFAULT_MAX_RECORDS);
    const query = {
      $filter: state.filter,
      $select: state.select,
      $top: limit + 1,
      $skip: state.skip,
      $orderby: state.orderby,
      $expand: state.expand,
      $count: state.count,
    };
    if (params.dry_run) {
      const plan = resolveReferences
        ? await planLookupExpand(services.metadataManager, state.collection, state.select, state.expand)
        : { expand: state.expand, fields: [] };
      const url = services.odataClient.previewCollectionUrl(state.collection, {
        ...query,
        $expand: plan.expand,
      });
      return {
        content: [{ type: 'text', text: `Запрос не выполнялся (dry_run=true). URL: ${url}` }],
        structuredContent: {
          collection: state.collection,
          dry_run: true,
          count: 0,
          has_more: false,
          records: [],
          display_records: [],
          field_labels: {},
          warnings,
          request: { url, filter: state.filter, select: state.select, expand: plan.expand },
          ...(search ? { compiled_filter: state.filter ?? '', used_fields: usedFields } : {}),
        },
      };
    }
    const deps = {
      metadataManager: services.metadataManager,
      odataClient: services.odataClient,
      odataVersion: services.config.odata_version,
    };
    let result;
    let records: Array<Record<string, unknown>>;
    if (state.nextLink) {
      result = await services.odataClient.getNextPage<Record<string, unknown>>(
        state.collection,
        state.nextLink,
        limit
      );
      records = resolveReferences ? await enrichLookups(result.value, state.collection, deps) : result.value;
    } else {
      const fetched = await getRecordsWithLookupNames(deps, state.collection, query, {
        autoPaginate: params.auto_paginate ?? false,
        maxRecords: limit,
        resolveLookups: resolveReferences,
      });
      result = fetched.response;
      records = fetched.records;
    }
    if (Buffer.byteLength(JSON.stringify(result.value)) > RESPONSE_BUDGET)
      throw new BpmApiError(
        'Ответ слишком велик. Выберите необходимые поля через select или уменьшите top.',
        400,
        state.collection,
        undefined,
        undefined,
        ['Используйте основные поля (уберите select="*") или уменьшите размер страницы.'],
        'validation'
      );
    const nextLink = result['@odata.nextLink'];
    warnings.push(...(result.warnings ?? []));
    const hasMore = Boolean(nextLink);
    const cursor = buildNextCursor({ ...state, nextLink }, result.value.length, hasMore, scope);
    const presentation = await presentRecords(services, state.collection, records, resolveReferences);
    warnings.push(...presentation.warnings);
    let totalCount = result['@odata.count'];
    if (state.count && totalCount === undefined)
      totalCount = await services.odataClient.getCount(state.collection, state.filter, warnings);
    const text = renderRecordsText(params.format === 'markdown' ? presentation.displayRecords : records, {
      collection: state.collection,
      format: params.format ?? 'compact',
      totalCount,
      nextLink,
      cursor,
    });
    return {
      content: [{ type: 'text', text: warnings.length ? `${text}\n\n${warnings.join('\n')}` : text }],
      structuredContent: {
        collection: state.collection,
        count: result.value.length,
        total_count: totalCount,
        has_more: hasMore,
        cursor,
        records,
        display_records: presentation.displayRecords,
        field_labels: presentation.fieldLabels,
        warnings,
        ...(search ? { compiled_filter: state.filter ?? '', used_fields: usedFields } : {}),
      },
    };
  } catch (error) {
    return errorResult(error, params.collection);
  }
}

export function registerReadTools(server: McpServer, services: ServiceContainer): void {
  for (const name of ['bpm_get_records', 'bpm_search_records'] as const) {
    const meta = getTool(name);
    const search = name === 'bpm_search_records';
    server.registerTool(
      meta.name,
      {
        title: meta.title,
        description: meta.description,
        annotations: meta.annotations,
        inputSchema: {
          ...pageInputs,
          ...(search
            ? {
                criteria: z.array(criterionSchema).max(100).optional(),
                join: z.enum(['and', 'or']).optional(),
              }
            : { filter: z.string().max(16384).optional() }),
        },
        outputSchema: {
          collection: z.string(),
          ...paginationShape,
          records: z.array(recordShape),
          ...presentationShape,
          dry_run: z.boolean().optional(),
          request: z
            .object({
              url: z.string(),
              filter: z.string().optional(),
              select: z.string().optional(),
              expand: z.string().optional(),
            })
            .optional(),
          ...(search
            ? {
                compiled_filter: z.string(),
                used_fields: z.array(
                  z.object({ input: z.string(), resolved: z.string(), caption: z.string().optional() })
                ),
              }
            : {}),
        },
      },
      async (params: PageParams) => listRecords(services, params, search)
    );
  }

  {
    const meta = getTool('bpm_get_record');
    server.registerTool(
      meta.name,
      {
        title: meta.title,
        description: meta.description,
        annotations: meta.annotations,
        inputSchema: {
          collection: z.string().min(1),
          id: z.string().min(1).describe('UUID или однозначное название записи.'),
          select: z.string().max(8192).optional(),
          expand: z.string().max(8192).optional(),
          resolve_references: z.boolean().optional(),
          resolve_lookups: z.boolean().optional(),
        },
        outputSchema: {
          collection: z.string(),
          id: z.string(),
          record: recordShape,
          display_record: recordShape,
          field_labels: z.record(z.string(), z.string()),
          warnings: z.array(z.string()),
          etag: z.string().optional(),
        },
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        try {
          await services.authManager.ensureAuthenticated();
          const warnings: string[] = [];
          const resolved = await resolveCollection(services, params.collection, { autoCorrect: true });
          const collection = resolved.name;
          if (resolved.note) warnings.push(resolved.note);
          const { id } = await resolveRecordId(services, collection, params.id);
          const record = await getRecordWithLookupNames(
            {
              metadataManager: services.metadataManager,
              odataClient: services.odataClient,
              odataVersion: services.config.odata_version,
            },
            collection,
            id,
            {
              $select: await selectForRead(services, collection, params.select ?? '*', warnings),
              $expand: params.expand,
            },
            { resolveLookups: params.resolve_references ?? params.resolve_lookups ?? true }
          );
          if (Buffer.byteLength(JSON.stringify(record)) > RESPONSE_BUDGET)
            throw new BpmApiError(
              'Запись слишком велика. Укажите необходимые поля в select.',
              400,
              collection
            );
          const presentation = await presentRecords(
            services,
            collection,
            [record],
            params.resolve_references ?? params.resolve_lookups ?? true
          );
          return {
            content: [
              {
                type: 'text',
                text: [
                  `Запись ${collection}(${id}):`,
                  ...Object.entries(compactRecord(record)).map(([key, value]) => `${key}: ${String(value)}`),
                  ...warnings,
                  ...presentation.warnings,
                ].join('\n'),
              },
            ],
            structuredContent: {
              collection,
              id,
              record,
              display_record: presentation.displayRecords[0],
              field_labels: presentation.fieldLabels,
              warnings: warnings.concat(presentation.warnings),
              ...(typeof record['@odata.etag'] === 'string' ? { etag: record['@odata.etag'] } : {}),
            },
          };
        } catch (error) {
          return errorResult(error, params.collection);
        }
      }
    );
  }
  {
    const meta = getTool('bpm_count_records');
    server.registerTool(
      meta.name,
      {
        title: meta.title,
        description: meta.description,
        annotations: meta.annotations,
        inputSchema: {
          collection: z.string().min(1),
          filter: z.string().max(16384).optional(),
          criteria: z.array(criterionSchema).max(100).optional(),
          join: z.enum(['and', 'or']).optional(),
        },
        outputSchema: {
          collection: z.string(),
          count: z.number().int().nonnegative(),
          filter: z.string().optional(),
          warnings: z.array(z.string()),
        },
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        try {
          await services.authManager.ensureAuthenticated();
          const collection = await canonicalCollection(services, params.collection);
          const compiled = params.criteria?.length
            ? await compileCriteria(services, collection, params.criteria as Criterion[], params.join, {
                autoCorrect: true,
              })
            : undefined;
          const filter = combineFilters(params.filter, compiled?.filter);
          const warnings: string[] = compiled?.warnings ?? [];
          const count = await services.odataClient.getCount(collection, filter, warnings);
          return {
            content: [{ type: 'text', text: [`${collection}: ${count} записей`, ...warnings].join('\n') }],
            structuredContent: { collection, count, filter, warnings },
          };
        } catch (error) {
          return errorResult(error, params.collection);
        }
      }
    );
  }
  registerAnalyticsTools(server, services);
}
