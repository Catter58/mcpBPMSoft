/**
 * MCP Tools: Write operations
 *
 * bpm_create_record       — create with lookup resolution + optional required-field validation
 * bpm_update_record       — update with lookup resolution
 * bpm_delete_record       — delete by ID
 * bpm_update_by_filter    — find by $filter and PATCH each (with safety expected_count)
 * bpm_delete_by_filter    — find by $filter and DELETE each (with safety expected_count)
 */

import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceContainer } from './init-tool.js';
import { formatToolError, LookupResolutionError } from '../utils/errors.js';
import { getTool } from './registry.js';
import {
  notInitialized,
  lookupNotesText,
  lookupNotesStructured,
  resolveCollectionName,
  resolveRecordId,
  compileCriteria,
  combineFilters,
} from './_guards.js';
import type { ResolvedLookupNote } from '../lookup/lookup-resolver.js';
import { confirmParam, confirmationRequired, confirmationResponse, previewIdList } from '../utils/confirm.js';
import { confirmShape, recordShape, resolvedLookupNoteShape, criterionSchema } from './_schemas.js';
import type { Criterion } from '../utils/filter-compiler.js';

function formatLookupAmbiguity(error: LookupResolutionError): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: [
          `Неоднозначное значение для поля "${error.field}": "${error.searchValue}"`,
          `Найдено ${error.matchCount} совпадений:`,
          ...error.candidates.map((c, i) => `  ${i + 1}. "${c.displayValue}" (ID: ${c.id})`),
          '',
          'Уточните значение или передайте UUID напрямую.',
        ].join('\n'),
      },
    ],
    isError: true,
  };
}

export function registerWriteTools(server: McpServer, services: ServiceContainer): void {
  // bpm_create_record
  {
    const meta = getTool('bpm_create_record');
    server.registerTool(
      meta.name,
      {
        title: meta.title,
        description: meta.description,
        inputSchema: {
          collection: z.string().describe('Имя коллекции (EntitySet), например: Contact, Account'),
          data: z
            .record(z.string(), z.unknown())
            .describe(
              'Данные записи в формате {"поле": "значение"}. Для lookup-полей можно передать текстовое значение вместо UUID — оно будет автоматически разрешено.'
            ),
          strict_required: z
            .boolean()
            .optional()
            .describe(
              'Если true, проверяет наличие всех non-nullable полей в data до отправки (по метаданным).'
            ),
        },
        outputSchema: {
          collection: z.string(),
          record: recordShape,
          resolved_lookups: z.array(resolvedLookupNoteShape).optional(),
        },
        annotations: meta.annotations,
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        try {
          await services.authManager.ensureAuthenticated();
          const collection = await resolveCollectionName(services, params.collection);

          if (params.strict_required) {
            const missing = await detectMissingRequired(services, collection, params.data);
            if (missing.length > 0) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `Отсутствуют обязательные поля: ${missing.join(', ')}. Передайте strict_required=false, если уверены.`,
                  },
                ],
                isError: true,
              };
            }
          }

          let resolvedData: Record<string, unknown>;
          let notes: ResolvedLookupNote[];
          try {
            const resolved = await services.lookupResolver.resolveDataLookups(collection, params.data);
            resolvedData = resolved.data;
            notes = resolved.notes;
          } catch (error) {
            if (error instanceof LookupResolutionError && error.matchCount > 1) {
              return formatLookupAmbiguity(error);
            }
            throw error;
          }

          const created = await services.odataClient.createRecord(collection, resolvedData);

          const notesLine = lookupNotesText(notes);
          return {
            content: [
              {
                type: 'text',
                text: [`Запись создана в ${collection}:`, JSON.stringify(created, null, 2), notesLine ?? '']
                  .filter(Boolean)
                  .join('\n'),
              },
            ],
            structuredContent: {
              collection: collection,
              record: created as unknown as Record<string, unknown>,
              ...(notes.length ? { resolved_lookups: lookupNotesStructured(notes) } : {}),
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

  // bpm_update_record
  {
    const meta = getTool('bpm_update_record');
    server.registerTool(
      meta.name,
      {
        title: meta.title,
        description: meta.description,
        inputSchema: {
          collection: z.string().describe('Имя коллекции (EntitySet)'),
          id: z
            .string()
            .describe('UUID записи для обновления или её название (Name/Title) — Id сервер найдёт сам'),
          data: z
            .record(z.string(), z.unknown())
            .describe('Поля для обновления. Lookup-поля с текстовыми значениями разрешаются автоматически.'),
        },
        outputSchema: {
          collection: z.string(),
          id: z.string(),
          updated_fields: z.array(z.string()),
          record: recordShape.optional().describe('Обновлённая запись, если сервер её вернул'),
          resolved_lookups: z.array(resolvedLookupNoteShape).optional(),
        },
        annotations: meta.annotations,
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        try {
          await services.authManager.ensureAuthenticated();
          const collection = await resolveCollectionName(services, params.collection);
          const { id } = await resolveRecordId(services, collection, params.id);

          let resolvedData: Record<string, unknown>;
          let notes: ResolvedLookupNote[];
          try {
            const resolved = await services.lookupResolver.resolveDataLookups(collection, params.data);
            resolvedData = resolved.data;
            notes = resolved.notes;
          } catch (error) {
            if (error instanceof LookupResolutionError && error.matchCount > 1) {
              return formatLookupAmbiguity(error);
            }
            throw error;
          }

          const updated = await services.odataClient.updateRecord(collection, id, resolvedData, {
            returnRepresentation: true,
          });

          const notesLine = lookupNotesText(notes);
          return {
            content: [
              {
                type: 'text',
                text: [
                  `Запись ${collection}(${id}) успешно обновлена.`,
                  `Обновлённые поля: ${Object.keys(resolvedData).join(', ')}`,
                  updated ? `Состояние записи после обновления:\n${JSON.stringify(updated, null, 2)}` : '',
                  notesLine ?? '',
                ]
                  .filter(Boolean)
                  .join('\n'),
              },
            ],
            structuredContent: {
              collection: collection,
              id,
              updated_fields: Object.keys(resolvedData),
              ...(updated ? { record: updated as Record<string, unknown> } : {}),
              ...(notes.length ? { resolved_lookups: lookupNotesStructured(notes) } : {}),
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

  // bpm_delete_record
  {
    const meta = getTool('bpm_delete_record');
    server.registerTool(
      meta.name,
      {
        title: meta.title,
        description: meta.description,
        inputSchema: {
          collection: z.string().describe('Имя коллекции (EntitySet)'),
          id: z
            .string()
            .describe('UUID записи для удаления или её название (Name/Title) — Id сервер найдёт сам'),
          confirm: confirmParam,
        },
        outputSchema: {
          ...confirmShape,
          collection: z.string(),
          id: z.string(),
          deleted: z.boolean().optional(),
        },
        annotations: meta.annotations,
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        try {
          await services.authManager.ensureAuthenticated();
          const collection = await resolveCollectionName(services, params.collection);
          const { id } = await resolveRecordId(services, collection, params.id);

          if (confirmationRequired(params)) {
            const record = await services.odataClient.getRecord(collection, id);
            return confirmationResponse(
              meta.name,
              [`Будет удалена запись ${collection}(${id}):`, JSON.stringify(record, null, 2)],
              { collection: collection, id }
            );
          }

          await services.odataClient.deleteRecord(collection, id);
          return {
            content: [{ type: 'text', text: `Запись ${collection}(${id}) успешно удалена.` }],
            structuredContent: { collection: collection, id, deleted: true },
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

  // bpm_update_by_filter
  {
    const meta = getTool('bpm_update_by_filter');
    server.registerTool(
      meta.name,
      {
        title: meta.title,
        description: meta.description,
        inputSchema: {
          collection: z.string().describe('Имя коллекции (EntitySet)'),
          filter: z.string().optional().describe('OData $filter (или criteria)'),
          criteria: z
            .array(criterionSchema)
            .optional()
            .describe(
              'Условие как в bpm_search_records — сервер сам соберёт $filter (объединяется с filter через and)'
            ),
          join: z
            .enum(['and', 'or'])
            .optional()
            .describe('Как соединять criteria: and (по умолчанию) или or'),
          data: z.record(z.string(), z.unknown()).describe('Поля для обновления (lookup резолвятся)'),
          expected_count: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              'Сколько записей должно совпасть; при несовпадении операция отменяется. Без него — только превью с числом найденных'
            ),
        },
        outputSchema: {
          code: z.string().optional(),
          collection: z.string().optional(),
          succeeded: z.array(z.string()).optional(),
          failed: z.array(z.object({ id: z.string(), error: z.string() })).optional(),
          found: z.number().int().optional(),
          filter: z.string().optional(),
          ids: z.array(z.string()).optional(),
          expected: z.number().int().optional(),
          resolved_lookups: z.array(resolvedLookupNoteShape).optional(),
        },
        annotations: meta.annotations,
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        try {
          await services.authManager.ensureAuthenticated();
          const collection = await resolveCollectionName(services, params.collection);
          const compiled = params.criteria?.length
            ? await compileCriteria(services, collection, params.criteria as Criterion[], params.join)
            : undefined;
          const filter = combineFilters(params.filter, compiled?.filter);
          if (!filter) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'Передайте filter или criteria: без условия массовая операция запрещена.',
                },
              ],
              isError: true,
            };
          }

          // Без expected_count ничего не меняем: показываем, что найдено, и число для повтора.
          if (params.expected_count === undefined) {
            const found = await services.odataClient.getRecords<Record<string, unknown>>(collection, {
              $filter: filter,
              $select: 'Id',
              $top: 1000,
            });
            const ids = found.value.map((rec) => String(rec.Id ?? rec.id));
            return {
              content: [
                {
                  type: 'text',
                  text: [
                    `По условию найдено ${ids.length}${ids.length === 1000 ? '+' : ''} записей в ${collection}: ${previewIdList(ids)}`,
                    `Ничего не изменено. Чтобы выполнить, повторите вызов с expected_count=${ids.length}.`,
                  ].join('\n'),
                },
              ],
              structuredContent: {
                code: 'expected_count_required',
                collection,
                filter,
                found: ids.length,
                ids,
              },
            };
          }

          const records = await services.odataClient.getRecords<Record<string, unknown>>(collection, {
            $filter: filter,
            $select: 'Id',
            $top: Math.max(params.expected_count + 1, 100),
          });

          if (records.value.length !== params.expected_count) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Найдено ${records.value.length} записей по фильтру, ожидалось ${params.expected_count}. Операция отменена для безопасности.`,
                },
              ],
              isError: true,
              structuredContent: {
                code: 'expected_count_mismatch',
                found: records.value.length,
                expected: params.expected_count,
              },
            };
          }

          let resolvedData: Record<string, unknown>;
          let notes: ResolvedLookupNote[];
          try {
            const resolved = await services.lookupResolver.resolveDataLookups(collection, params.data);
            resolvedData = resolved.data;
            notes = resolved.notes;
          } catch (error) {
            if (error instanceof LookupResolutionError && error.matchCount > 1) {
              return formatLookupAmbiguity(error);
            }
            throw error;
          }

          const succeeded: string[] = [];
          const failed: Array<{ id: string; error: string }> = [];
          for (const rec of records.value) {
            const id = String(rec.Id ?? rec.id);
            try {
              await services.odataClient.updateRecord(collection, id, resolvedData);
              succeeded.push(id);
            } catch (e) {
              failed.push({ id, error: e instanceof Error ? e.message : String(e) });
            }
          }

          return {
            content: [
              {
                type: 'text',
                text: [
                  `Обновление по фильтру ${collection}:`,
                  `  Запросов: ${records.value.length}`,
                  `  Успешно: ${succeeded.length}`,
                  `  Ошибок: ${failed.length}`,
                  lookupNotesText(notes) ?? '',
                  failed.length ? '\nОшибки:\n' + failed.map((f) => `  ${f.id}: ${f.error}`).join('\n') : '',
                ]
                  .filter(Boolean)
                  .join('\n'),
              },
            ],
            isError: failed.length > 0 && succeeded.length === 0,
            structuredContent: {
              collection: collection,
              succeeded,
              failed,
              ...(notes.length ? { resolved_lookups: lookupNotesStructured(notes) } : {}),
            },
          };
        } catch (error) {
          const toolError = formatToolError(error, params.collection);
          return { content: [{ type: 'text', text: JSON.stringify(toolError, null, 2) }], isError: true };
        }
      }
    );
  }

  // bpm_delete_by_filter
  {
    const meta = getTool('bpm_delete_by_filter');
    server.registerTool(
      meta.name,
      {
        title: meta.title,
        description: meta.description,
        inputSchema: {
          collection: z.string().describe('Имя коллекции (EntitySet)'),
          filter: z.string().optional().describe('OData $filter (или criteria)'),
          criteria: z
            .array(criterionSchema)
            .optional()
            .describe(
              'Условие как в bpm_search_records — сервер сам соберёт $filter (объединяется с filter через and)'
            ),
          join: z
            .enum(['and', 'or'])
            .optional()
            .describe('Как соединять criteria: and (по умолчанию) или or'),
          expected_count: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              'Сколько записей должно совпасть; при несовпадении операция отменяется. Без него — только превью с числом найденных'
            ),
          confirm: confirmParam,
        },
        outputSchema: {
          ...confirmShape,
          collection: z.string().optional(),
          filter: z.string().optional(),
          count: z.number().int().optional(),
          ids: z.array(z.string()).optional(),
          succeeded: z.array(z.string()).optional(),
          failed: z.array(z.object({ id: z.string(), error: z.string() })).optional(),
          found: z.number().int().optional(),
          expected: z.number().int().optional(),
        },
        annotations: meta.annotations,
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        try {
          await services.authManager.ensureAuthenticated();
          const collection = await resolveCollectionName(services, params.collection);
          const compiled = params.criteria?.length
            ? await compileCriteria(services, collection, params.criteria as Criterion[], params.join)
            : undefined;
          const filter = combineFilters(params.filter, compiled?.filter);
          if (!filter) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'Передайте filter или criteria: без условия массовая операция запрещена.',
                },
              ],
              isError: true,
            };
          }

          // Без expected_count ничего не меняем: показываем, что найдено, и число для повтора.
          if (params.expected_count === undefined) {
            const found = await services.odataClient.getRecords<Record<string, unknown>>(collection, {
              $filter: filter,
              $select: 'Id',
              $top: 1000,
            });
            const ids = found.value.map((rec) => String(rec.Id ?? rec.id));
            return {
              content: [
                {
                  type: 'text',
                  text: [
                    `По условию найдено ${ids.length}${ids.length === 1000 ? '+' : ''} записей в ${collection}: ${previewIdList(ids)}`,
                    `Ничего не изменено. Чтобы выполнить, повторите вызов с expected_count=${ids.length}.`,
                  ].join('\n'),
                },
              ],
              structuredContent: {
                code: 'expected_count_required',
                collection,
                filter,
                found: ids.length,
                ids,
              },
            };
          }

          const records = await services.odataClient.getRecords<Record<string, unknown>>(collection, {
            $filter: filter,
            $select: 'Id',
            $top: Math.max(params.expected_count + 1, 100),
          });

          if (records.value.length !== params.expected_count) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Найдено ${records.value.length} записей по фильтру, ожидалось ${params.expected_count}. Удаление отменено.`,
                },
              ],
              isError: true,
              structuredContent: {
                code: 'expected_count_mismatch',
                found: records.value.length,
                expected: params.expected_count,
              },
            };
          }

          const ids = records.value.map((rec) => String(rec.Id ?? rec.id));

          if (confirmationRequired(params)) {
            return confirmationResponse(
              meta.name,
              [
                `По фильтру найдено ${ids.length} записей в ${collection}, которые будут удалены:`,
                previewIdList(ids),
              ],
              { collection: collection, filter, count: ids.length, ids }
            );
          }

          const succeeded: string[] = [];
          const failed: Array<{ id: string; error: string }> = [];
          for (const id of ids) {
            try {
              await services.odataClient.deleteRecord(collection, id);
              succeeded.push(id);
            } catch (e) {
              failed.push({ id, error: e instanceof Error ? e.message : String(e) });
            }
          }

          return {
            content: [
              {
                type: 'text',
                text: [
                  `Удаление по фильтру ${collection}:`,
                  `  Запросов: ${ids.length}`,
                  `  Успешно: ${succeeded.length}`,
                  `  Ошибок: ${failed.length}`,
                  failed.length ? '\nОшибки:\n' + failed.map((f) => `  ${f.id}: ${f.error}`).join('\n') : '',
                ]
                  .filter(Boolean)
                  .join('\n'),
              },
            ],
            isError: failed.length > 0 && succeeded.length === 0,
            structuredContent: {
              collection: collection,
              succeeded,
              failed,
            },
          };
        } catch (error) {
          const toolError = formatToolError(error, params.collection);
          return { content: [{ type: 'text', text: JSON.stringify(toolError, null, 2) }], isError: true };
        }
      }
    );
  }
}

async function detectMissingRequired(
  services: ServiceContainer,
  collection: string,
  data: Record<string, unknown>
): Promise<string[]> {
  try {
    const meta = await services.metadataManager.getEntityMetadata(collection);
    const dataKeys = new Set(Object.keys(data));
    const missing: string[] = [];
    for (const prop of meta.properties) {
      if (prop.nullable) continue;
      if (prop.name === 'Id') continue;
      // Lookup field present under base name (e.g. "City" instead of "CityId")
      const altName = prop.name.endsWith('Id') ? prop.name.slice(0, -2) : `${prop.name}Id`;
      if (!dataKeys.has(prop.name) && !dataKeys.has(altName)) {
        missing.push(prop.name);
      }
    }
    return missing;
  } catch {
    return [];
  }
}
