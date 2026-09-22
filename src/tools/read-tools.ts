/**
 * MCP Tools: Read operations
 *
 * bpm_get_records  — list records with filters (safe pagination by default)
 * bpm_get_record   — single record by ID
 * bpm_count_records — count with optional filter
 * bpm_search_records — criteria-DSL with field-resolution
 */

import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceContainer } from './init-tool.js';
import { formatToolError } from '../utils/errors.js';
import { getTool } from './registry.js';
import {
  notInitialized,
  resolveRecordId,
  compileCriteria,
  combineFilters,
  resolveCollection,
  autoCorrectingMetadata,
} from './_guards.js';
import { compileFilter, type Criterion } from '../utils/filter-compiler.js';
import { compactRecord } from '../utils/compact.js';
import { isQueryUnsupportedError } from '../utils/errors.js';
import { markTolowerUnsupported } from '../utils/server-capabilities.js';
import { renderRecordsText, type RenderFormat } from '../utils/render.js';
import { decodeCursor, buildNextCursor, type CursorState } from '../utils/cursor.js';
import { paginationShape, recordShape, criterionSchema } from './_schemas.js';
import {
  resolveSelect,
  getRecordsWithLookupNames,
  getRecordWithLookupNames,
  planLookupExpand,
  ALL_COLUMNS,
  resolveOrderBy,
} from '../utils/display.js';

const DEFAULT_TOP = 100;
const DEFAULT_MAX_RECORDS = 1000;
const FORMAT_VALUES = ['compact', 'full', 'markdown'] as const;

const SELECT_DESCRIPTION =
  'Поля для выборки через запятую. Если не указано — сервер вернёт только Id и колонку отображения ' +
  `(Name/Title/...), чтобы не раздувать контекст. Для всех колонок передайте select='${ALL_COLUMNS}'.`;

const DRY_RUN_DESCRIPTION =
  'Не выполнять запрос, а вернуть то, что сервер собрал: итоговый URL, $filter, $select и $expand. ' +
  'Полезно, чтобы проверить критерии перед выборкой и увидеть, как разрешились имена полей.';

const RESOLVE_LOOKUPS_DESCRIPTION =
  'Подставлять ли имена связанных записей в lookup-колонки: рядом с CityId появится CityName (по умолчанию true). ' +
  'Стоит по одному доп. запросу на каждый задействованный справочник — отключается значением false.';

export function registerReadTools(server: McpServer, services: ServiceContainer): void {
  // bpm_get_records
  {
    const meta = getTool('bpm_get_records');
    server.registerTool(
      meta.name,
      {
        title: meta.title,
        description: meta.description,
        inputSchema: {
          collection: z
            .string()
            .optional()
            .describe(
              'Имя коллекции (EntitySet), например: Contact, Account, City. Не нужно если передан cursor.'
            ),
          filter: z.string().optional().describe("OData $filter, например: Name eq 'Иванов'"),
          select: z.string().optional().describe(SELECT_DESCRIPTION),
          resolve_lookups: z.boolean().optional().describe(RESOLVE_LOOKUPS_DESCRIPTION),
          dry_run: z.boolean().optional().describe(DRY_RUN_DESCRIPTION),
          top: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(`Максимум записей за один запрос (по умолчанию ${DEFAULT_TOP})`),
          skip: z.number().int().nonnegative().optional().describe('Пропустить N записей (для пагинации)'),
          orderby: z.string().optional().describe('Сортировка, например: Name asc, CreatedOn desc'),
          expand: z.string().optional().describe('Развернуть связанные сущности'),
          count: z.boolean().optional().describe('Включить общее количество записей в ответ'),
          auto_paginate: z
            .boolean()
            .optional()
            .describe(
              'Следовать @odata.nextLink до исчерпания (по умолчанию false). Используйте с max_records.'
            ),
          max_records: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(`Жёсткий потолок числа записей в ответе (по умолчанию ${DEFAULT_MAX_RECORDS})`),
          format: z
            .enum(FORMAT_VALUES)
            .optional()
            .describe(
              "Формат текстовой выдачи: 'compact' (по умолчанию) — сводка + до 50 записей по строке на каждую (только непустые поля); 'full' — полный JSON; 'markdown' — таблица для ≤20 записей. structuredContent всегда полный."
            ),
          cursor: z
            .string()
            .optional()
            .describe(
              'Opaque-курсор предыдущего ответа для получения следующей страницы. При его передаче все остальные параметры запроса наследуются от того ответа.'
            ),
        },
        outputSchema: {
          collection: z.string(),
          ...paginationShape,
          records: z.array(recordShape),
          warnings: z.array(z.string()).optional().describe('Автоисправления имён коллекции и полей'),
          dry_run: z.boolean().optional(),
          request: z
            .object({
              url: z.string(),
              filter: z.string().optional(),
              select: z.string().optional(),
              expand: z.string().optional(),
            })
            .optional()
            .describe('Что ушло бы на сервер (только при dry_run)'),
        },
        annotations: meta.annotations,
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        try {
          await services.authManager.ensureAuthenticated();

          // При передаче cursor все параметры запроса наследуются из него
          let collection: string;
          let filter: string | undefined;
          let select: string | undefined;
          let top: number;
          let skip: number | undefined;
          let orderby: string | undefined;
          let expand: string | undefined;
          let count: boolean | undefined;

          if (params.cursor) {
            const state = decodeCursor(params.cursor);
            collection = state.collection;
            filter = state.filter;
            select = state.select;
            top = state.top ?? DEFAULT_TOP;
            skip = state.skip;
            orderby = state.orderby;
            expand = state.expand;
            count = state.count;
          } else {
            if (!params.collection) {
              throw new Error('Параметр collection обязателен (или передайте cursor)');
            }
            collection = params.collection;
            filter = params.filter;
            select = params.select;
            top = params.top ?? DEFAULT_TOP;
            skip = params.skip;
            orderby = params.orderby;
            expand = params.expand;
            count = params.count;
          }

          const warnings: string[] = [];
          const resolved = await resolveCollection(services, collection, { autoCorrect: true });
          collection = resolved.name;
          if (resolved.note) warnings.push(resolved.note);
          const maxRecords = params.max_records ?? DEFAULT_MAX_RECORDS;
          const autoPaginate = params.auto_paginate ?? false;
          const effectiveSelect = await resolveSelect(services.metadataManager, collection, select, warnings);
          const effectiveOrderBy = await resolveOrderBy(
            services.metadataManager,
            collection,
            orderby,
            warnings
          );

          const query = {
            $filter: filter,
            $select: effectiveSelect,
            $top: top,
            $skip: skip,
            $orderby: effectiveOrderBy,
            $expand: expand,
            $count: count,
          };

          if (params.dry_run) {
            return withWarnings(
              await dryRunResult(services, collection, query, params.resolve_lookups),
              warnings
            );
          }

          const { response: result, records } = await getRecordsWithLookupNames(
            lookupDeps(services),
            collection,
            query,
            { autoPaginate, maxRecords, resolveLookups: params.resolve_lookups }
          );

          const truncated = result.value.length === maxRecords && Boolean(result['@odata.nextLink']);
          const hasMore = Boolean(result['@odata.nextLink']);

          const cursorState: CursorState = {
            v: 1,
            collection,
            filter,
            select,
            orderby,
            expand,
            count,
            top,
            skip: skip ?? 0,
          };
          const nextCursor = buildNextCursor(cursorState, result.value.length, hasMore);

          const text = renderRecordsText(records, {
            format: params.format as RenderFormat | undefined,
            collection,
            totalCount: result['@odata.count'],
            truncated,
            nextLink: result['@odata.nextLink'],
            cursor: nextCursor,
          });

          return withWarnings(
            {
              content: [{ type: 'text', text }],
              structuredContent: {
                collection,
                count: records.length,
                total_count: result['@odata.count'],
                has_more: hasMore || truncated,
                cursor: nextCursor,
                records,
              },
            },
            warnings
          );
        } catch (error) {
          const toolError = formatToolError(error, params.collection);
          // Стенд оборвал ответ на ручном $filter (на тестовом стенде так ведут себя `XxxId eq null`, `tolower()`,
          // `in`): criteria-путь собирает совместимые конструкции сам.
          if (params.filter && isQueryUnsupportedError(error)) {
            toolError.next_steps = [
              'Сервер не разобрал такой $filter и оборвал ответ. Передайте условие через bpm_search_records ' +
                '(criteria) — сервер соберёт совместимый фильтр сам.',
              ...(toolError.next_steps ?? []),
            ];
          }
          return {
            content: [{ type: 'text', text: JSON.stringify(toolError, null, 2) }],
            isError: true,
          };
        }
      }
    );
  }

  // bpm_get_record
  {
    const meta = getTool('bpm_get_record');
    server.registerTool(
      meta.name,
      {
        title: meta.title,
        description: meta.description,
        inputSchema: {
          collection: z.string().describe('Имя коллекции (EntitySet)'),
          id: z.string().describe('UUID записи или её название (Name/Title) — Id сервер найдёт сам'),
          select: z.string().optional().describe(SELECT_DESCRIPTION),
          resolve_lookups: z.boolean().optional().describe(RESOLVE_LOOKUPS_DESCRIPTION),
          expand: z.string().optional().describe('Развернуть связанные сущности'),
        },
        outputSchema: {
          collection: z.string(),
          id: z.string(),
          record: recordShape,
          warnings: z.array(z.string()).optional().describe('Автоисправления имён коллекции и полей'),
        },
        annotations: meta.annotations,
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        try {
          await services.authManager.ensureAuthenticated();

          const warnings: string[] = [];
          const resolved = await resolveCollection(services, params.collection, { autoCorrect: true });
          const collection = resolved.name;
          if (resolved.note) warnings.push(resolved.note);
          // Одна запись — все колонки по умолчанию: второй вызов «а покажи ещё поле» дороже.
          const effectiveSelect = params.select?.trim()
            ? await resolveSelect(services.metadataManager, collection, params.select, warnings)
            : undefined;
          const { id } = await resolveRecordId(services, collection, params.id);

          const record = await getRecordWithLookupNames(
            lookupDeps(services),
            collection,
            id,
            { $select: effectiveSelect, $expand: params.expand },
            { resolveLookups: params.resolve_lookups }
          );

          // Текст — только содержательные поля; полная запись — в structuredContent.
          const lines = Object.entries(compactRecord(record)).map(([k, v]) => `${k}: ${String(v)}`);
          return withWarnings(
            {
              content: [{ type: 'text', text: `Запись ${collection}(${id}):\n${lines.join('\n')}` }],
              structuredContent: { collection, id, record },
            },
            warnings
          );
        } catch (error) {
          const toolError = formatToolError(error, params.collection);
          return {
            content: [{ type: 'text', text: JSON.stringify(toolError, null, 2) }],
            isError: true,
          };
        }
      }
    );
  }

  // bpm_count_records
  {
    const meta = getTool('bpm_count_records');
    server.registerTool(
      meta.name,
      {
        title: meta.title,
        description: meta.description,
        inputSchema: {
          collection: z.string().describe('Имя коллекции (EntitySet)'),
          filter: z.string().optional().describe('OData $filter выражение'),
          criteria: z
            .array(criterionSchema)
            .optional()
            .describe(
              'Критерии как в bpm_search_records — сервер сам соберёт $filter (объединяется с filter через and)'
            ),
          join: z
            .enum(['and', 'or'])
            .optional()
            .describe('Как соединять criteria: and (по умолчанию) или or'),
        },
        outputSchema: {
          collection: z.string(),
          filter: z.string().optional(),
          count: z.number().int(),
          warnings: z.array(z.string()).optional().describe('Автоисправления имён коллекции и полей'),
        },
        annotations: meta.annotations,
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        try {
          await services.authManager.ensureAuthenticated();

          const resolved = await resolveCollection(services, params.collection, { autoCorrect: true });
          const collection = resolved.name;
          const compiled = params.criteria?.length
            ? await compileCriteria(services, collection, params.criteria as Criterion[], params.join, {
                autoCorrect: true,
              })
            : undefined;
          const filter = combineFilters(params.filter, compiled?.filter);
          const count = await services.odataClient.getCount(collection, filter);
          const warnings = [...(resolved.note ? [resolved.note] : []), ...(compiled?.warnings ?? [])];

          return withWarnings(
            {
              content: [
                {
                  type: 'text',
                  text: `Количество записей в ${collection}${filter ? ` (фильтр: ${filter})` : ''}: ${count}`,
                },
              ],
              structuredContent: { collection, filter, count },
            },
            warnings
          );
        } catch (error) {
          const toolError = formatToolError(error, params.collection);
          return {
            content: [{ type: 'text', text: JSON.stringify(toolError, null, 2) }],
            isError: true,
          };
        }
      }
    );
  }

  // bpm_search_records
  {
    const meta = getTool('bpm_search_records');
    server.registerTool(
      meta.name,
      {
        title: meta.title,
        description: meta.description,
        inputSchema: {
          collection: z.string().describe('Имя коллекции (EntitySet)'),
          criteria: z.array(criterionSchema).describe('Массив критериев — компилируется в OData $filter'),
          join: z
            .enum(['and', 'or'])
            .optional()
            .describe('Как соединять критерии: and (по умолчанию) или or'),
          select: z.string().optional().describe(SELECT_DESCRIPTION),
          resolve_lookups: z.boolean().optional().describe(RESOLVE_LOOKUPS_DESCRIPTION),
          dry_run: z.boolean().optional().describe(DRY_RUN_DESCRIPTION),
          orderby: z.string().optional().describe('Сортировка'),
          top: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(`Максимум за один запрос (по умолчанию ${DEFAULT_TOP})`),
          skip: z.number().int().nonnegative().optional().describe('Пропустить N записей'),
          expand: z.string().optional().describe('Развернуть связанные сущности'),
          count: z.boolean().optional().describe('Включить общее количество записей в ответ'),
          auto_paginate: z
            .boolean()
            .optional()
            .describe('Следовать @odata.nextLink до исчерпания (по умолчанию false)'),
          max_records: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(`Жёсткий потолок числа записей в ответе (по умолчанию ${DEFAULT_MAX_RECORDS})`),
          format: z
            .enum(FORMAT_VALUES)
            .optional()
            .describe(
              "Формат выдачи: 'compact' (по умолчанию) — до 50 записей по строке на каждую; 'full' — полный JSON; 'markdown' — таблица."
            ),
        },
        outputSchema: {
          collection: z.string(),
          compiled_filter: z.string(),
          used_fields: z.array(
            z.object({ input: z.string(), resolved: z.string(), caption: z.string().optional() })
          ),
          warnings: z.array(z.string()),
          ...paginationShape,
          records: z.array(recordShape),
          dry_run: z.boolean().optional(),
          request: z
            .object({
              url: z.string(),
              filter: z.string().optional(),
              select: z.string().optional(),
              expand: z.string().optional(),
            })
            .optional(),
        },
        annotations: meta.annotations,
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        try {
          await services.authManager.ensureAuthenticated();

          const resolved = await resolveCollection(services, params.collection, { autoCorrect: true });
          const collection = resolved.name;
          // Исправленные поля: criteria — через обёртку metadataManager, select/orderby — напрямую.
          const fieldNotes: string[] = [];
          const compileOptions = {
            collection,
            metadataManager: autoCorrectingMetadata(services.metadataManager, fieldNotes),
            odataVersion: services.config.odata_version,
            join: params.join,
            // «сегодня» считается в поясе пользователя, а не сервера
            timeZone: await userTimeZone(services),
            currentUser: services.currentUser,
          };
          let compiled = await compileFilter(params.criteria as Criterion[], compileOptions);

          const top = params.top ?? DEFAULT_TOP;
          const maxRecords = params.max_records ?? DEFAULT_MAX_RECORDS;
          const autoPaginate = params.auto_paginate ?? false;
          const effectiveSelect = await resolveSelect(
            services.metadataManager,
            collection,
            params.select,
            fieldNotes
          );

          const searchQuery = {
            $filter: compiled.filter || undefined,
            $select: effectiveSelect,
            $top: top,
            $skip: params.skip,
            $orderby: await resolveOrderBy(services.metadataManager, collection, params.orderby, fieldNotes),
            $expand: params.expand,
            $count: params.count,
          };

          const corrections = () => [...(resolved.note ? [resolved.note] : []), ...new Set(fieldNotes)];
          compiled.warnings.unshift(...corrections());

          if (params.dry_run) {
            const preview = await dryRunResult(services, collection, searchQuery, params.resolve_lookups);
            const structured = preview.structuredContent as Record<string, unknown>;
            structured.compiled_filter = compiled.filter;
            structured.used_fields = compiled.used_fields;
            structured.warnings = compiled.warnings;
            return preview;
          }

          // $filter берём из текущего compiled: после отказа tolower() он пересобран.
          const runSearch = () =>
            getRecordsWithLookupNames(
              lookupDeps(services),
              collection,
              { ...searchQuery, $filter: compiled.filter || undefined },
              {
                autoPaginate,
                maxRecords,
                resolveLookups: params.resolve_lookups,
              }
            );

          let fetched;
          try {
            fetched = await runSearch();
          } catch (error) {
            // Инстанс не переварил tolower() (на некоторых стендах это обрыв
            // потока, а не 4xx) — запоминаем это, пересобираем фильтр
            // case-sensitive и пробуем ещё раз, вместо ошибки в лицо модели.
            if (!compiled.filter.includes('tolower(') || !isQueryUnsupportedError(error)) throw error;
            markTolowerUnsupported();
            compiled = await compileFilter(params.criteria as Criterion[], compileOptions);
            compiled.warnings.unshift(...corrections());
            compiled.warnings.push(
              'Инстанс не поддерживает tolower(): поиск по подстроке выполнен с учётом регистра.'
            );
            fetched = await runSearch();
          }
          const { response: result, records } = fetched;

          const truncated = result.value.length === maxRecords && Boolean(result['@odata.nextLink']);
          const hasMore = Boolean(result['@odata.nextLink']);
          const cursorState: CursorState = {
            v: 1,
            collection,
            filter: compiled.filter || undefined,
            select: params.select,
            orderby: params.orderby,
            expand: params.expand,
            count: params.count,
            top,
            skip: params.skip ?? 0,
            criteria: params.criteria,
            join: params.join,
          };
          const nextCursor = buildNextCursor(cursorState, result.value.length, hasMore);

          const summaryPrefix: string[] = [`Скомпилированный $filter: ${compiled.filter || '(пусто)'}`];
          if (compiled.warnings.length > 0) {
            summaryPrefix.push(`Предупреждения:\n  • ${compiled.warnings.join('\n  • ')}`);
          }
          const renderedBody = renderRecordsText(records, {
            format: params.format as RenderFormat | undefined,
            collection,
            totalCount: result['@odata.count'],
            truncated,
            nextLink: result['@odata.nextLink'],
            cursor: nextCursor,
          });
          const text = `${summaryPrefix.join('\n')}\n\n${renderedBody}`;

          return {
            content: [{ type: 'text', text }],
            structuredContent: {
              collection,
              compiled_filter: compiled.filter,
              used_fields: compiled.used_fields,
              warnings: compiled.warnings,
              count: records.length,
              total_count: result['@odata.count'],
              has_more: hasMore || truncated,
              cursor: nextCursor,
              records,
            },
          };
        } catch (error) {
          const toolError = formatToolError(error, params.collection);
          return {
            content: [{ type: 'text', text: JSON.stringify(toolError, null, 2) }],
            isError: true,
          };
        }
      }
    );
  }
}

/**
 * Предпросмотр запроса без обращения к BPMSoft: собранный URL и параметры.
 * $expand считается так же, как в боевом пути, чтобы предпросмотр не расходился
 * с тем, что реально уйдёт на сервер.
 */
async function dryRunResult(
  services: ServiceContainer,
  collection: string,
  query: {
    $filter?: string;
    $select?: string;
    $top?: number;
    $skip?: number;
    $orderby?: string;
    $expand?: string;
    $count?: boolean;
  },
  resolveLookups: boolean | undefined
): Promise<CallToolResult> {
  const plan =
    resolveLookups === false
      ? { expand: query.$expand, fields: [] }
      : await planLookupExpand(services.metadataManager, collection, query.$select, query.$expand);
  const effectiveQuery = { ...query, $expand: plan.expand };
  const url = services.odataClient.previewCollectionUrl(collection, effectiveQuery);

  const lines = [
    'Запрос не выполнялся (dry_run=true). На сервер ушло бы:',
    `  URL:     ${url}`,
    `  $filter: ${effectiveQuery.$filter ?? '(нет)'}`,
    `  $select: ${effectiveQuery.$select ?? '(все колонки)'}`,
    `  $expand: ${effectiveQuery.$expand ?? '(нет)'}`,
  ];

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    structuredContent: {
      collection,
      dry_run: true,
      count: 0,
      has_more: false,
      records: [],
      request: {
        url,
        ...(effectiveQuery.$filter ? { filter: effectiveQuery.$filter } : {}),
        ...(effectiveQuery.$select ? { select: effectiveQuery.$select } : {}),
        ...(effectiveQuery.$expand ? { expand: effectiveQuery.$expand } : {}),
      },
    },
  };
}

/**
 * Часовой пояс текущего пользователя для календарных операторов.
 * Недоступность DataService не должна ронять поиск — падаем на пояс сервера.
 */
async function userTimeZone(services: ServiceContainer): Promise<string | undefined> {
  try {
    const user = await services.currentUser.get();
    return user.timeZoneId;
  } catch {
    return undefined;
  }
}

/** Автоисправления имён — строкой в начало текста и полем `warnings` в structuredContent. */
function withWarnings(result: CallToolResult, warnings: string[]): CallToolResult {
  if (warnings.length === 0) return result;
  const note = `Предупреждения: ${warnings.join('; ')}`;
  const [first, ...rest] = result.content;
  return {
    ...result,
    content:
      first?.type === 'text' ? [{ type: 'text', text: `${note}\n${first.text}` }, ...rest] : result.content,
    structuredContent: { ...result.structuredContent, warnings },
  };
}

/** Зависимости подстановки имён lookup-полей из сервис-контейнера. */
function lookupDeps(services: ServiceContainer) {
  return {
    metadataManager: services.metadataManager,
    odataClient: services.odataClient,
    odataVersion: services.config.odata_version,
  };
}
