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
import { notInitialized } from './_guards.js';
import { compileFilter, type Criterion } from '../utils/filter-compiler.js';
import { renderRecordsText, type RenderFormat } from '../utils/render.js';
import { decodeCursor, buildNextCursor, type CursorState } from '../utils/cursor.js';

const DEFAULT_TOP = 100;
const DEFAULT_MAX_RECORDS = 1000;
const FORMAT_VALUES = ['compact', 'full', 'markdown'] as const;

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
          collection: z.string().optional().describe('Имя коллекции (EntitySet), например: Contact, Account, City. Не нужно если передан cursor.'),
          filter: z.string().optional().describe('OData $filter, например: Name eq \'Иванов\''),
          select: z.string().optional().describe('Поля для выборки через запятую'),
          top: z.number().int().positive().optional().describe(`Максимум записей за один запрос (по умолчанию ${DEFAULT_TOP})`),
          skip: z.number().int().nonnegative().optional().describe('Пропустить N записей (для пагинации)'),
          orderby: z.string().optional().describe('Сортировка, например: Name asc, CreatedOn desc'),
          expand: z.string().optional().describe('Развернуть связанные сущности'),
          count: z.boolean().optional().describe('Включить общее количество записей в ответ'),
          auto_paginate: z
            .boolean()
            .optional()
            .describe('Следовать @odata.nextLink до исчерпания (по умолчанию false). Используйте с max_records.'),
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
              "Формат текстовой выдачи: 'compact' (по умолчанию) — сводка + первые 5 записей; 'full' — полный JSON; 'markdown' — таблица для ≤20 записей. structuredContent всегда полный."
            ),
          cursor: z
            .string()
            .optional()
            .describe('Opaque-курсор предыдущего ответа для получения следующей страницы. При его передаче все остальные параметры запроса наследуются от того ответа.'),
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

          const maxRecords = params.max_records ?? DEFAULT_MAX_RECORDS;
          const autoPaginate = params.auto_paginate ?? false;

          const result = await services.odataClient.getRecords(
            collection,
            {
              $filter: filter,
              $select: select,
              $top: top,
              $skip: skip,
              $orderby: orderby,
              $expand: expand,
              $count: count,
            },
            autoPaginate,
            maxRecords
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

          const text = renderRecordsText(result.value as Array<Record<string, unknown>>, {
            format: params.format as RenderFormat | undefined,
            collection,
            totalCount: result['@odata.count'],
            truncated,
            nextLink: result['@odata.nextLink'],
            cursor: nextCursor,
          });

          return {
            content: [{ type: 'text', text }],
            structuredContent: {
              collection,
              count: result.value.length,
              total_count: result['@odata.count'],
              next_link: result['@odata.nextLink'],
              cursor: nextCursor,
              truncated,
              records: result.value,
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
          id: z.string().describe('UUID записи'),
          select: z.string().optional().describe('Поля для выборки через запятую'),
          expand: z.string().optional().describe('Развернуть связанные сущности'),
        },
        annotations: meta.annotations,
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        try {
          await services.authManager.ensureAuthenticated();

          const result = await services.odataClient.getRecord(params.collection, params.id, {
            $select: params.select,
            $expand: params.expand,
          });

          return {
            content: [
              {
                type: 'text',
                text: `Запись ${params.collection}(${params.id}):\n${JSON.stringify(result, null, 2)}`,
              },
            ],
            structuredContent: { collection: params.collection, id: params.id, record: result as unknown as Record<string, unknown> },
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
        },
        annotations: meta.annotations,
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        try {
          await services.authManager.ensureAuthenticated();

          const count = await services.odataClient.getCount(params.collection, params.filter);

          return {
            content: [
              {
                type: 'text',
                text: `Количество записей в ${params.collection}${params.filter ? ` (фильтр: ${params.filter})` : ''}: ${count}`,
              },
            ],
            structuredContent: { collection: params.collection, filter: params.filter, count },
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

  // bpm_search_records
  {
    const meta = getTool('bpm_search_records');
    const criterionSchema = z.object({
      field: z.string().describe('Имя поля, caption или путь навигации (например "Account.City")'),
      op: z
        .string()
        .describe(
          'Оператор: равно/eq, не равно/ne, больше/gt, больше или равно/ge, меньше/lt, меньше или равно/le, содержит/contains, не содержит/not_contains, начинается с/startswith, заканчивается на/endswith, в списке/in, пусто/is_null, не пусто/is_not_null, за последние N дней/in_last_days, за последние N часов/in_last_hours, между/between'
        ),
      value: z.unknown().optional().describe('Значение (отсутствует для is_null/is_not_null)'),
      value_to: z.unknown().optional().describe('Верхняя граница для оператора between'),
    });

    server.registerTool(
      meta.name,
      {
        title: meta.title,
        description: meta.description,
        inputSchema: {
          collection: z.string().describe('Имя коллекции (EntitySet)'),
          criteria: z
            .array(criterionSchema)
            .describe('Массив критериев — компилируется в OData $filter'),
          join: z
            .enum(['and', 'or'])
            .optional()
            .describe('Как соединять критерии: and (по умолчанию) или or'),
          select: z.string().optional().describe('Поля для выборки через запятую'),
          orderby: z.string().optional().describe('Сортировка'),
          top: z.number().int().positive().optional().describe(`Максимум за один запрос (по умолчанию ${DEFAULT_TOP})`),
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
              "Формат выдачи: 'compact' (по умолчанию) — превью; 'full' — полный JSON; 'markdown' — таблица."
            ),
        },
        annotations: meta.annotations,
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        try {
          await services.authManager.ensureAuthenticated();

          const compiled = await compileFilter(params.criteria as Criterion[], {
            collection: params.collection,
            metadataManager: services.metadataManager,
            odataVersion: services.config.odata_version,
            join: params.join,
          });

          const top = params.top ?? DEFAULT_TOP;
          const maxRecords = params.max_records ?? DEFAULT_MAX_RECORDS;
          const autoPaginate = params.auto_paginate ?? false;

          const result = await services.odataClient.getRecords(
            params.collection,
            {
              $filter: compiled.filter || undefined,
              $select: params.select,
              $top: top,
              $skip: params.skip,
              $orderby: params.orderby,
              $expand: params.expand,
              $count: params.count,
            },
            autoPaginate,
            maxRecords
          );

          const truncated = result.value.length === maxRecords && Boolean(result['@odata.nextLink']);
          const hasMore = Boolean(result['@odata.nextLink']);
          const cursorState: CursorState = {
            v: 1,
            collection: params.collection,
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

          const summaryPrefix: string[] = [
            `Скомпилированный $filter: ${compiled.filter || '(пусто)'}`,
          ];
          if (compiled.warnings.length > 0) {
            summaryPrefix.push(`Предупреждения:\n  • ${compiled.warnings.join('\n  • ')}`);
          }
          const renderedBody = renderRecordsText(result.value as Array<Record<string, unknown>>, {
            format: params.format as RenderFormat | undefined,
            collection: params.collection,
            totalCount: result['@odata.count'],
            truncated,
            nextLink: result['@odata.nextLink'],
            cursor: nextCursor,
          });
          const text = `${summaryPrefix.join('\n')}\n\n${renderedBody}`;

          return {
            content: [{ type: 'text', text }],
            structuredContent: {
              collection: params.collection,
              compiled_filter: compiled.filter,
              used_fields: compiled.used_fields,
              warnings: compiled.warnings,
              count: result.value.length,
              total_count: result['@odata.count'],
              next_link: result['@odata.nextLink'],
              cursor: nextCursor,
              truncated,
              records: result.value,
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
