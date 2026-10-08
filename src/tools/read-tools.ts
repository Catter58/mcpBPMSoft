import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceContainer } from './init-tool.js';
import { formatToolError, BpmApiError } from '../utils/errors.js';
import { getTool } from './registry.js';
import {
  notInitialized,
  resolveRecordTarget,
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
import { READ_FORMATS, renderRecordsText, type RenderFormat } from '../utils/render.js';
import { decodeCursor, buildNextCursor, type CursorState } from '../utils/cursor.js';
import { continuationForResult } from '../client/odata-client.js';
import { getAuthCacheScope } from '../auth/request-context.js';
import { paginationShape, recordShape, criterionSchema, matchBySchema, matchedByShape } from './_schemas.js';
import { canonicalCollection, readSelect, presentRecords } from '../read/record-presentation.js';
import { registerAnalyticsTools } from './analytics-tools.js';
import { compactRecord } from '../utils/compact.js';
import { assertGuid } from '../utils/odata.js';
import { verifyRecordState } from '../read/record-verification.js';
import {
  READ_RESULT_BYTE_LIMIT,
  serializedResultBytes,
  serializedResultBytesAfterTextLimit,
} from '../server/response-budget.js';

const DEFAULT_TOP = 20;
const DEFAULT_MAX_RECORDS = 1000;
const AUTO_PAGE_CHUNK_SIZE = 100;
const RESPONSE_BUDGET = 512 * 1024;

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
  format: z
    .enum(READ_FORMATS)
    .optional()
    .describe(
      'compact (по умолчанию), markdown, full или summary; summary не повторяет значения строк в content, записи остаются в structuredContent.'
    ),
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

const verificationInput = z.discriminatedUnion('operation', [
  z.object({ operation: z.enum(['create', 'update']), expected: recordShape }),
  z.object({ operation: z.literal('delete') }),
]);

const verificationShape = z.object({
  operation: z.enum(['create', 'update', 'delete']),
  observation: z.enum(['matches', 'differs', 'absent', 'unavailable']),
  safe_to_retry: z.literal(false),
  observed_at: z.string(),
  differences: z
    .array(
      z.object({
        field: z.string(),
        expected: z.unknown(),
        actual: z.unknown(),
        actual_present: z.boolean(),
      })
    )
    .optional(),
  reason: z.string().optional(),
});

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
    const requestedResolveReferences = params.resolve_references ?? params.resolve_lookups;
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
        autoPaginate: params.auto_paginate ?? false,
        format: params.format,
        resolveReferences: requestedResolveReferences ?? true,
        skip: params.skip ?? 0,
      };
    }
    const autoPaginate = params.auto_paginate ?? state.autoPaginate ?? false;
    const format = params.format ?? state.format ?? 'compact';
    const resolveReferences = requestedResolveReferences ?? state.resolveReferences ?? true;
    state.autoPaginate = autoPaginate;
    state.format = format;
    state.resolveReferences = resolveReferences;
    const limit = autoPaginate
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
    const makeReadOutput = (
      pageRecords: Array<Record<string, unknown>>,
      pageDisplayRecords: Array<Record<string, unknown>>,
      pageLabels: Record<string, string>,
      pageWarnings: string[],
      countValue: number | undefined,
      next: string | undefined,
      cursorRowCount = pageRecords.length,
      stopReason?: 'continuation_available' | 'record_limit_reached' | 'response_byte_budget'
    ): CallToolResult => {
      const hasMore = Boolean(next);
      const cursor = buildNextCursor(
        { ...state, autoPaginate, format, resolveReferences, nextLink: next },
        cursorRowCount,
        hasMore,
        scope
      );
      const fieldNames = new Set(pageRecords.flatMap((record) => Object.keys(record)));
      const labels = Object.fromEntries(
        Object.entries(pageLabels).filter(([field]) => fieldNames.has(field))
      );
      const text = renderRecordsText(format === 'markdown' ? pageDisplayRecords : pageRecords, {
        collection: state.collection,
        format,
        totalCount: countValue,
        nextLink: next,
        cursor,
      });
      return {
        content: [
          { type: 'text', text: pageWarnings.length ? `${text}\n\n${pageWarnings.join('\n')}` : text },
        ],
        structuredContent: {
          collection: state.collection,
          count: pageRecords.length,
          total_count: countValue,
          has_more: hasMore,
          cursor,
          records: pageRecords,
          display_records: pageDisplayRecords,
          field_labels: labels,
          warnings: pageWarnings,
          ...((stopReason ?? (hasMore ? 'continuation_available' : undefined))
            ? { stop_reason: stopReason ?? 'continuation_available' }
            : {}),
          ...(search ? { compiled_filter: state.filter ?? '', used_fields: usedFields } : {}),
        },
      };
    };
    const deps = {
      metadataManager: services.metadataManager,
      odataClient: services.odataClient,
      odataVersion: services.config.odata_version,
    };
    if (autoPaginate) {
      const maxRecords = params.max_records ?? DEFAULT_MAX_RECORDS;
      let records: Array<Record<string, unknown>> = [];
      let displayRecords: Array<Record<string, unknown>> = [];
      let fieldLabels: Record<string, string> = {};
      const pageWarnings = [...warnings];
      let totalCount: number | undefined;
      let output: CallToolResult | undefined;
      let continuation = state.nextLink;
      let firstRequest = !state.nextLink;
      let nextChunkSize = Math.min(AUTO_PAGE_CHUNK_SIZE, maxRecords);
      const visited = new Set<string>();

      const fitsBudget = (candidate: CallToolResult): boolean =>
        serializedResultBytes(candidate) <= READ_RESULT_BYTE_LIMIT &&
        serializedResultBytesAfterTextLimit(candidate) <= READ_RESULT_BYTE_LIMIT;

      while (records.length < maxRecords) {
        const chunkSize = Math.min(nextChunkSize, maxRecords - records.length);
        let requestUrl: string;
        let response;
        let chunkRecords: Array<Record<string, unknown>>;
        if (firstRequest) {
          const chunkQuery = {
            $filter: state.filter,
            $select: state.select,
            $top: chunkSize + 1,
            $skip: state.skip,
            $orderby: state.orderby,
            $expand: state.expand,
            $count: state.count,
          };
          requestUrl = services.odataClient.previewCollectionUrl(state.collection, chunkQuery);
          if (visited.has(requestUrl))
            throw new BpmApiError('Сервер вернул повторяющуюся ссылку пагинации.', 502, state.collection);
          visited.add(requestUrl);
          const fetched = await getRecordsWithLookupNames(deps, state.collection, chunkQuery, {
            autoPaginate: false,
            maxRecords: chunkSize,
            resolveLookups: resolveReferences,
          });
          response = fetched.response;
          chunkRecords = fetched.records;
          firstRequest = false;
        } else {
          if (!continuation) break;
          requestUrl = continuation;
          if (visited.has(requestUrl))
            throw new BpmApiError('Сервер вернул повторяющуюся ссылку пагинации.', 502, state.collection);
          visited.add(requestUrl);
          response = await services.odataClient.getNextPage<Record<string, unknown>>(
            state.collection,
            requestUrl,
            chunkSize
          );
          chunkRecords = resolveReferences
            ? await enrichLookups(response.value, state.collection, deps)
            : response.value;
        }

        pageWarnings.push(...(response.warnings ?? []));
        if (totalCount === undefined) totalCount = response['@odata.count'];
        if (state.count && totalCount === undefined)
          totalCount = await services.odataClient.getCount(state.collection, state.filter, pageWarnings);
        if (chunkRecords.length === 0) {
          if (response['@odata.nextLink']) {
            continuation = response['@odata.nextLink'];
            continue;
          }
          output = makeReadOutput(records, displayRecords, fieldLabels, pageWarnings, totalCount, undefined);
          break;
        }

        const presentation = await presentRecords(
          services,
          state.collection,
          chunkRecords,
          resolveReferences
        );
        pageWarnings.push(...presentation.warnings);
        const combinedLabels = { ...fieldLabels, ...presentation.fieldLabels };
        const makeCandidate = (accepted: number): CallToolResult => {
          const pageRecords = [...records, ...chunkRecords.slice(0, accepted)];
          const pageDisplayRecords = [...displayRecords, ...presentation.displayRecords.slice(0, accepted)];
          const next =
            accepted < chunkRecords.length
              ? continuationForResult(response, accepted, requestUrl)
              : response['@odata.nextLink'];
          return makeReadOutput(
            pageRecords,
            pageDisplayRecords,
            combinedLabels,
            pageWarnings,
            totalCount,
            next
          );
        };

        let candidate = makeCandidate(chunkRecords.length);
        if (fitsBudget(candidate)) {
          records = [...records, ...chunkRecords];
          displayRecords = [...displayRecords, ...presentation.displayRecords];
          fieldLabels = combinedLabels;
          continuation = response['@odata.nextLink'];
          output = candidate;
          if (!continuation) break;
          if (records.length >= maxRecords) {
            output = {
              ...candidate,
              structuredContent: { ...candidate.structuredContent, stop_reason: 'record_limit_reached' },
            };
            break;
          }
          const usedBytes = serializedResultBytes(output);
          const estimatedBytesPerRow = Math.max(1, Math.ceil(usedBytes / records.length));
          const projectedRows = Math.max(
            1,
            Math.floor((READ_RESULT_BYTE_LIMIT - usedBytes) / estimatedBytesPerRow)
          );
          nextChunkSize = Math.min(AUTO_PAGE_CHUNK_SIZE, maxRecords - records.length, projectedRows);
          continue;
        }

        let accepted = chunkRecords.length;
        while (accepted > 1 && !fitsBudget(candidate)) {
          accepted = Math.floor(accepted / 2);
          candidate = makeCandidate(accepted);
        }
        if (!fitsBudget(candidate)) {
          if (records.length === 0)
            throw new BpmApiError(
              'Запись слишком велика для ответа. Укажите необходимые поля в select.',
              400,
              state.collection
            );
          candidate = makeCandidate(0);
          if (!fitsBudget(candidate))
            throw new BpmApiError('Ответ слишком велик для лимита страницы.', 400, state.collection);
          output = {
            ...candidate,
            structuredContent: { ...candidate.structuredContent, stop_reason: 'response_byte_budget' },
          };
          break;
        }
        let lower = accepted;
        let upper = chunkRecords.length;
        while (lower + 1 < upper) {
          const middle = Math.floor((lower + upper) / 2);
          const middleCandidate = makeCandidate(middle);
          if (fitsBudget(middleCandidate)) {
            lower = middle;
            candidate = middleCandidate;
          } else {
            upper = middle;
          }
        }
        output = {
          ...candidate,
          structuredContent: { ...candidate.structuredContent, stop_reason: 'response_byte_budget' },
        };
        break;
      }

      return (
        output ?? makeReadOutput(records, displayRecords, fieldLabels, pageWarnings, totalCount, continuation)
      );
    }
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
        autoPaginate,
        maxRecords: limit,
        resolveLookups: resolveReferences,
      });
      result = fetched.response;
      records = fetched.records;
    }
    if (!autoPaginate && Buffer.byteLength(JSON.stringify(result.value)) > RESPONSE_BUDGET)
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
    const presentation = await presentRecords(services, state.collection, records, resolveReferences);
    warnings.push(...presentation.warnings);
    let totalCount = result['@odata.count'];
    if (state.count && totalCount === undefined)
      totalCount = await services.odataClient.getCount(state.collection, state.filter, warnings);
    return makeReadOutput(
      records,
      presentation.displayRecords,
      presentation.fieldLabels,
      warnings,
      totalCount,
      nextLink,
      result.value.length
    );
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
          stop_reason: z
            .enum(['continuation_available', 'record_limit_reached', 'response_byte_budget'])
            .optional(),
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
          id: z.string().min(1).optional().describe('UUID или однозначное название записи.'),
          match_by: matchBySchema.optional(),
          select: z.string().max(8192).optional(),
          expand: z.string().max(8192).optional(),
          resolve_references: z.boolean().optional(),
          resolve_lookups: z.boolean().optional(),
          verify: verificationInput
            .optional()
            .describe(
              'Только чтение по точным UUID и имени коллекции: сверить create/update expected либо проверить отсутствующий после delete. Не повторяет запись.'
            ),
        },
        outputSchema: {
          collection: z.string(),
          id: z.string(),
          record: recordShape.optional(),
          display_record: recordShape.optional(),
          field_labels: z.record(z.string(), z.string()).optional(),
          warnings: z.array(z.string()).optional(),
          etag: z.string().optional(),
          verification: verificationShape.optional(),
          matched_by: matchedByShape.optional(),
        },
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        try {
          await services.authManager.ensureAuthenticated();
          const warnings: string[] = [];
          let collection: string;
          let id: string;
          let matchedBy: Awaited<ReturnType<typeof resolveRecordTarget>>['matched_by'];
          let verification: Awaited<ReturnType<typeof verifyRecordState>> | undefined;
          if (params.verify) {
            if (params.match_by !== undefined)
              throw new BpmApiError(
                'verify требует точный UUID в id и не совмещается с match_by.',
                400,
                params.collection
              );
            if (!params.id)
              throw new BpmApiError('Для verify передайте точный UUID в id.', 400, params.collection);
            if (params.select !== undefined || params.expand !== undefined)
              throw new BpmApiError(
                'select и expand нельзя совмещать с verify: проверка читает только поля expected.',
                400,
                params.collection
              );
            assertGuid(params.id, 'id');
            const resolved = await resolveCollection(services, params.collection);
            if (resolved.name !== params.collection)
              throw new BpmApiError(
                'Для verify передайте точное имя коллекции без автоисправлений.',
                400,
                params.collection
              );
            collection = params.collection;
            id = params.id;
            verification = await verifyRecordState(services, collection, id, params.verify);
            const observationText =
              verification.observation === 'absent'
                ? `Запись ${collection}(${id}) сейчас отсутствует.`
                : verification.observation === 'unavailable'
                  ? `Текущее состояние недоступно: ${verification.reason ?? 'причина неизвестна'}.`
                  : verification.observation === 'matches'
                    ? 'Указанные поля совпадают с expected на момент чтения.'
                    : (verification.reason ?? 'Указанные поля отличаются от expected.');
            const differenceLines = (verification.differences ?? []).map(
              (difference) =>
                `• ${difference.field}: expected=${JSON.stringify(difference.expected)}; actual=${difference.actual_present ? JSON.stringify(difference.actual) : '<отсутствует в ответе>'}`
            );
            return {
              content: [
                {
                  type: 'text',
                  text: [
                    `Проверка ${verification.operation}: ${verification.observation}. ${observationText}`,
                    ...differenceLines,
                    'Проверка фиксирует только текущее наблюдение и не доказывает, что его вызвала предыдущая запись. Автоматически повторять запись нельзя.',
                  ].join('\n'),
                },
              ],
              structuredContent: { collection, id, verification },
            };
          } else {
            if ((params.id === undefined) === (params.match_by === undefined))
              throw new BpmApiError(
                'Передайте ровно один параметр: id или match_by.',
                400,
                params.collection
              );
            const resolved = await resolveCollection(services, params.collection, { autoCorrect: true });
            collection = resolved.name;
            if (resolved.note) warnings.push(resolved.note);
            const target = await resolveRecordTarget(services, collection, {
              id: params.id,
              match_by: params.match_by,
            });
            id = target.id;
            matchedBy = target.matched_by;
          }
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
                  ...Object.entries(compactRecord(presentation.displayRecords[0])).map(
                    ([key, value]) => `${key}: ${String(value)}`
                  ),
                  ...warnings,
                  ...presentation.warnings,
                  ...(verification
                    ? [
                        `Проверка ${verification.operation}: ${verification.observation}; автоматически повторять нельзя.`,
                      ]
                    : []),
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
              ...(matchedBy ? { matched_by: matchedBy } : {}),
              ...(verification ? { verification } : {}),
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
