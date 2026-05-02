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
import { notInitialized } from './_guards.js';

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
            .describe('Если true, проверяет наличие всех non-nullable полей в data до отправки (по метаданным).'),
        },
        annotations: meta.annotations,
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        try {
          await services.authManager.ensureAuthenticated();

          if (params.strict_required) {
            const missing = await detectMissingRequired(services, params.collection, params.data);
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
          try {
            resolvedData = await services.lookupResolver.resolveDataLookups(params.collection, params.data);
          } catch (error) {
            if (error instanceof LookupResolutionError && error.matchCount > 1) {
              return formatLookupAmbiguity(error);
            }
            throw error;
          }

          const created = await services.odataClient.createRecord(params.collection, resolvedData);

          return {
            content: [
              { type: 'text', text: `Запись создана в ${params.collection}:\n${JSON.stringify(created, null, 2)}` },
            ],
            structuredContent: { collection: params.collection, record: created as unknown as Record<string, unknown> },
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
          id: z.string().describe('UUID записи для обновления'),
          data: z
            .record(z.string(), z.unknown())
            .describe('Поля для обновления. Lookup-поля с текстовыми значениями разрешаются автоматически.'),
        },
        annotations: meta.annotations,
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        try {
          await services.authManager.ensureAuthenticated();

          let resolvedData: Record<string, unknown>;
          try {
            resolvedData = await services.lookupResolver.resolveDataLookups(params.collection, params.data);
          } catch (error) {
            if (error instanceof LookupResolutionError && error.matchCount > 1) {
              return formatLookupAmbiguity(error);
            }
            throw error;
          }

          await services.odataClient.updateRecord(params.collection, params.id, resolvedData);

          return {
            content: [
              {
                type: 'text',
                text: `Запись ${params.collection}(${params.id}) успешно обновлена.\nОбновлённые поля: ${Object.keys(resolvedData).join(', ')}`,
              },
            ],
            structuredContent: {
              collection: params.collection,
              id: params.id,
              updated_fields: Object.keys(resolvedData),
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
          id: z.string().describe('UUID записи для удаления'),
        },
        annotations: meta.annotations,
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        try {
          await services.authManager.ensureAuthenticated();
          await services.odataClient.deleteRecord(params.collection, params.id);
          return {
            content: [{ type: 'text', text: `Запись ${params.collection}(${params.id}) успешно удалена.` }],
            structuredContent: { collection: params.collection, id: params.id, deleted: true },
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
          collection: z.string(),
          filter: z.string().describe('OData $filter — обязателен, не должен быть пустым'),
          data: z.record(z.string(), z.unknown()).describe('Поля для обновления (lookup резолвятся)'),
          expected_count: z.number().int().positive().describe('Сколько записей должен вернуть фильтр; иначе откат'),
        },
        annotations: meta.annotations,
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        try {
          await services.authManager.ensureAuthenticated();
          if (!params.filter.trim()) {
            return { content: [{ type: 'text', text: 'filter не может быть пустым' }], isError: true };
          }

          const records = await services.odataClient.getRecords<Record<string, unknown>>(
            params.collection,
            { $filter: params.filter, $select: 'Id', $top: Math.max(params.expected_count + 1, 100) }
          );

          if (records.value.length !== params.expected_count) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Найдено ${records.value.length} записей по фильтру, ожидалось ${params.expected_count}. Операция отменена для безопасности.`,
                },
              ],
              isError: true,
              structuredContent: { found: records.value.length, expected: params.expected_count },
            };
          }

          let resolvedData: Record<string, unknown>;
          try {
            resolvedData = await services.lookupResolver.resolveDataLookups(params.collection, params.data);
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
              await services.odataClient.updateRecord(params.collection, id, resolvedData);
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
                  `Обновление по фильтру ${params.collection}:`,
                  `  Запросов: ${records.value.length}`,
                  `  Успешно: ${succeeded.length}`,
                  `  Ошибок: ${failed.length}`,
                  failed.length ? '\nОшибки:\n' + failed.map((f) => `  ${f.id}: ${f.error}`).join('\n') : '',
                ].filter(Boolean).join('\n'),
              },
            ],
            isError: failed.length > 0 && succeeded.length === 0,
            structuredContent: {
              collection: params.collection,
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

  // bpm_delete_by_filter
  {
    const meta = getTool('bpm_delete_by_filter');
    server.registerTool(
      meta.name,
      {
        title: meta.title,
        description: meta.description,
        inputSchema: {
          collection: z.string(),
          filter: z.string().describe('OData $filter — обязателен'),
          expected_count: z.number().int().positive().describe('Сколько записей должно совпадать; иначе откат'),
        },
        annotations: meta.annotations,
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        try {
          await services.authManager.ensureAuthenticated();
          if (!params.filter.trim()) {
            return { content: [{ type: 'text', text: 'filter не может быть пустым' }], isError: true };
          }

          const records = await services.odataClient.getRecords<Record<string, unknown>>(
            params.collection,
            { $filter: params.filter, $select: 'Id', $top: Math.max(params.expected_count + 1, 100) }
          );

          if (records.value.length !== params.expected_count) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Найдено ${records.value.length} записей по фильтру, ожидалось ${params.expected_count}. Удаление отменено.`,
                },
              ],
              isError: true,
              structuredContent: { found: records.value.length, expected: params.expected_count },
            };
          }

          const succeeded: string[] = [];
          const failed: Array<{ id: string; error: string }> = [];
          for (const rec of records.value) {
            const id = String(rec.Id ?? rec.id);
            try {
              await services.odataClient.deleteRecord(params.collection, id);
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
                  `Удаление по фильтру ${params.collection}:`,
                  `  Запросов: ${records.value.length}`,
                  `  Успешно: ${succeeded.length}`,
                  `  Ошибок: ${failed.length}`,
                  failed.length ? '\nОшибки:\n' + failed.map((f) => `  ${f.id}: ${f.error}`).join('\n') : '',
                ].filter(Boolean).join('\n'),
              },
            ],
            isError: failed.length > 0 && succeeded.length === 0,
            structuredContent: {
              collection: params.collection,
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
