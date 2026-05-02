/**
 * MCP Tools: Batch operations (OData v4 only)
 *
 * bpm_batch_create — create multiple records in one $batch
 * bpm_batch_update — update multiple records in one $batch
 * bpm_batch_delete — delete multiple records in one $batch
 */

import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceContainer } from './init-tool.js';
import { formatToolError } from '../utils/errors.js';
import { getTool } from './registry.js';
import { notInitialized } from './_guards.js';

export function registerBatchTools(server: McpServer, services: ServiceContainer): void {
  // bpm_batch_create
  {
    const meta = getTool('bpm_batch_create');
    server.registerTool(
      meta.name,
      {
        title: meta.title,
        description: meta.description,
        inputSchema: {
          collection: z.string(),
          records: z
            .array(z.record(z.string(), z.unknown()))
            .describe('Массив записей для создания (lookup-поля резолвятся)'),
          continue_on_error: z.boolean().optional().describe('Не прерывать batch на первой ошибке (Prefer: continue-on-error)'),
        },
        annotations: meta.annotations,
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        try {
          await services.authManager.ensureAuthenticated();

          if (params.records.length === 0) {
            return { content: [{ type: 'text', text: 'Массив записей пуст. Нечего создавать.' }], isError: true };
          }

          const resolvedRecords: Record<string, unknown>[] = [];
          for (let i = 0; i < params.records.length; i++) {
            try {
              const resolved = await services.lookupResolver.resolveDataLookups(params.collection, params.records[i]);
              resolvedRecords.push(resolved);
            } catch (error) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `Ошибка резолвинга lookup в записи #${i + 1}: ${error instanceof Error ? error.message : String(error)}`,
                  },
                ],
                isError: true,
              };
            }
          }

          const collectionPath = services.odataClient.buildCollectionPath(params.collection);
          const batchRequests = resolvedRecords.map((record) => ({
            method: 'POST' as const,
            url: collectionPath,
            body: record,
          }));

          const result = await services.odataClient.executeBatch(batchRequests, params.continue_on_error ?? false);

          const succeeded = result.responses
            .map((r, i) => ({ index: i, ...r }))
            .filter((r) => r.status >= 200 && r.status < 300);
          const failed = result.responses
            .map((r, i) => ({ index: i, ...r }))
            .filter((r) => r.status >= 300);

          const lines = [
            `Пакетное создание в ${params.collection}:`,
            `  Всего запросов: ${params.records.length}`,
            `  Успешно создано: ${succeeded.length}`,
            `  Ошибок: ${failed.length}`,
          ];
          if (failed.length > 0) {
            lines.push('', 'Ошибки:');
            failed.forEach((f) => lines.push(`  #${f.index + 1}: HTTP ${f.status} — ${JSON.stringify(f.body).slice(0, 300)}`));
          }

          return {
            content: [{ type: 'text', text: lines.join('\n') }],
            isError: failed.length > 0 && succeeded.length === 0,
            structuredContent: {
              collection: params.collection,
              total: params.records.length,
              succeeded: succeeded.length,
              failed: failed.length,
              created: succeeded.map((s) => (s.body as Record<string, unknown> | null)?.Id ?? null),
              first_failed_index: failed.length > 0 ? failed[0].index : null,
            },
          };
        } catch (error) {
          const toolError = formatToolError(error, params.collection);
          return { content: [{ type: 'text', text: JSON.stringify(toolError, null, 2) }], isError: true };
        }
      }
    );
  }

  // bpm_batch_update
  {
    const meta = getTool('bpm_batch_update');
    server.registerTool(
      meta.name,
      {
        title: meta.title,
        description: meta.description,
        inputSchema: {
          collection: z.string(),
          updates: z
            .array(
              z.object({
                id: z.string(),
                data: z.record(z.string(), z.unknown()),
              })
            )
            .describe('Массив обновлений [{id, data}]'),
          continue_on_error: z.boolean().optional().describe('Не прерывать batch на первой ошибке'),
        },
        annotations: meta.annotations,
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        try {
          await services.authManager.ensureAuthenticated();

          if (params.updates.length === 0) {
            return { content: [{ type: 'text', text: 'Массив обновлений пуст.' }], isError: true };
          }

          const batchRequests: Array<{ method: 'PATCH'; url: string; body: Record<string, unknown> }> = [];
          for (let i = 0; i < params.updates.length; i++) {
            const update = params.updates[i];
            try {
              const resolvedData = await services.lookupResolver.resolveDataLookups(params.collection, update.data);
              batchRequests.push({
                method: 'PATCH',
                url: services.odataClient.buildRecordPath(params.collection, update.id),
                body: resolvedData,
              });
            } catch (error) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `Ошибка резолвинга lookup в обновлении #${i + 1} (ID: ${update.id}): ${error instanceof Error ? error.message : String(error)}`,
                  },
                ],
                isError: true,
              };
            }
          }

          const result = await services.odataClient.executeBatch(batchRequests, params.continue_on_error ?? false);

          const succeeded = result.responses
            .map((r, i) => ({ index: i, ...r }))
            .filter((r) => r.status >= 200 && r.status < 300);
          const failed = result.responses
            .map((r, i) => ({ index: i, ...r }))
            .filter((r) => r.status >= 300);

          const lines = [
            `Пакетное обновление в ${params.collection}:`,
            `  Всего запросов: ${params.updates.length}`,
            `  Успешно обновлено: ${succeeded.length}`,
            `  Ошибок: ${failed.length}`,
          ];
          if (failed.length > 0) {
            lines.push('', 'Ошибки:');
            failed.forEach((f) =>
              lines.push(`  #${f.index + 1} (id=${params.updates[f.index]?.id}): HTTP ${f.status} — ${JSON.stringify(f.body).slice(0, 300)}`)
            );
          }

          return {
            content: [{ type: 'text', text: lines.join('\n') }],
            isError: failed.length > 0 && succeeded.length === 0,
            structuredContent: {
              collection: params.collection,
              total: params.updates.length,
              succeeded: succeeded.length,
              failed: failed.length,
              first_failed_index: failed.length > 0 ? failed[0].index : null,
            },
          };
        } catch (error) {
          const toolError = formatToolError(error, params.collection);
          return { content: [{ type: 'text', text: JSON.stringify(toolError, null, 2) }], isError: true };
        }
      }
    );
  }

  // bpm_batch_delete
  {
    const meta = getTool('bpm_batch_delete');
    server.registerTool(
      meta.name,
      {
        title: meta.title,
        description: meta.description,
        inputSchema: {
          collection: z.string(),
          ids: z.array(z.string()).describe('Массив UUID записей для удаления'),
          continue_on_error: z.boolean().optional().describe('Не прерывать batch на первой ошибке'),
        },
        annotations: meta.annotations,
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        try {
          await services.authManager.ensureAuthenticated();
          if (params.ids.length === 0) {
            return { content: [{ type: 'text', text: 'Массив ID пуст. Нечего удалять.' }], isError: true };
          }

          const batchRequests = params.ids.map((id) => ({
            method: 'DELETE' as const,
            url: services.odataClient.buildRecordPath(params.collection, id),
          }));

          const result = await services.odataClient.executeBatch(batchRequests, params.continue_on_error ?? false);

          const succeeded = result.responses
            .map((r, i) => ({ index: i, ...r }))
            .filter((r) => r.status >= 200 && r.status < 300);
          const failed = result.responses
            .map((r, i) => ({ index: i, ...r }))
            .filter((r) => r.status >= 300);

          const lines = [
            `Пакетное удаление из ${params.collection}:`,
            `  Всего запросов: ${params.ids.length}`,
            `  Успешно удалено: ${succeeded.length}`,
            `  Ошибок: ${failed.length}`,
          ];
          if (failed.length > 0) {
            lines.push('', 'Ошибки:');
            failed.forEach((f) =>
              lines.push(`  #${f.index + 1} (id=${params.ids[f.index]}): HTTP ${f.status} — ${JSON.stringify(f.body).slice(0, 300)}`)
            );
          }

          return {
            content: [{ type: 'text', text: lines.join('\n') }],
            isError: failed.length > 0 && succeeded.length === 0,
            structuredContent: {
              collection: params.collection,
              total: params.ids.length,
              succeeded: succeeded.length,
              failed: failed.length,
              first_failed_index: failed.length > 0 ? failed[0].index : null,
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
