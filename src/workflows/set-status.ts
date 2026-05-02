/**
 * MCP Tool: bpm_set_status
 *
 * Set the status field of a record by its human-readable name. The status
 * field itself is auto-detected in the entity metadata (any lookup field
 * whose name contains "Status" or "Stage").
 */

import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceContainer } from '../tools/init-tool.js';
import type { EntityProperty } from '../types/index.js';
import { BpmApiError, UnknownCollectionError, formatToolError } from '../utils/errors.js';
import { getTool } from '../tools/registry.js';
import { notInitialized } from '../tools/_guards.js';

function isStatusFieldName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes('status') || lower.includes('stage') || lower.includes('state');
}

export function registerSetStatusTool(server: McpServer, services: ServiceContainer): void {
  const meta = getTool('bpm_set_status');
  server.registerTool(
    meta.name,
    {
      title: meta.title,
      description: meta.description,
      inputSchema: {
        collection: z.string().describe('Имя коллекции (EntitySet), например: Opportunity, Lead, Activity'),
        id: z.string().describe('UUID записи, у которой меняется статус'),
        status: z.string().describe('Человекочитаемое имя статуса (Name справочника)'),
        status_field: z
          .string()
          .optional()
          .describe(
            'Явное имя поля-статуса (если в коллекции несколько кандидатов: StatusId, StageId и т.п.)'
          ),
      },
      annotations: meta.annotations,
    },
    async (params): Promise<CallToolResult> => {
      if (!services.initialized) return notInitialized();
      try {
        await services.authManager.ensureAuthenticated();

        const collRef = await services.metadataManager.resolveCollectionReference(params.collection);
        if (collRef.name === null) {
          throw new UnknownCollectionError(params.collection, collRef.suggestions);
        }
        const collection = collRef.name;

        const entityMeta = await services.metadataManager.getEntityMetadata(collection);

        let statusField: EntityProperty | undefined;
        if (params.status_field) {
          const ref = await services.metadataManager.resolveFieldReference(collection, params.status_field);
          if (ref.name === null) {
            throw new BpmApiError(
              `Поле "${params.status_field}" не найдено в коллекции ${collection}`,
              400,
              collection,
              undefined,
              ref.suggestions
            );
          }
          statusField = entityMeta.properties.find((p) => p.name === ref.name);
        } else {
          const candidates = entityMeta.properties.filter(
            (p) => p.isLookup && isStatusFieldName(p.name)
          );
          if (candidates.length === 0) {
            throw new BpmApiError(
              `В коллекции ${collection} не найдено lookup-поле статуса (имя содержит Status/Stage/State).`,
              400,
              collection,
              undefined,
              undefined,
              [
                `Запросите схему: bpm_get_schema(${collection}).`,
                `Или передайте имя поля явно через status_field.`,
              ]
            );
          }
          if (candidates.length > 1) {
            throw new BpmApiError(
              `Найдено несколько статусных полей: ${candidates.map((c) => c.name).join(', ')}. Передайте status_field явно.`,
              400,
              collection,
              undefined,
              candidates.map((c) => c.name),
              [`Повторите вызов, добавив параметр status_field='<нужное имя>'.`]
            );
          }
          statusField = candidates[0];
        }

        if (!statusField) {
          throw new BpmApiError(
            `Не удалось определить статусное поле в коллекции ${collection}.`,
            400,
            collection
          );
        }

        const lookupInfo = await services.metadataManager.getLookupInfo(collection, statusField.name);
        if (!lookupInfo) {
          throw new BpmApiError(
            `Поле ${statusField.name} в ${collection} не является lookup-полем — изменение статуса невозможно.`,
            400,
            collection
          );
        }

        const lookupResult = await services.lookupResolver.resolve(
          lookupInfo.lookupCollection,
          params.status,
          lookupInfo.displayColumn
        );
        if (!lookupResult.resolved || !lookupResult.id) {
          throw new BpmApiError(
            `Статус "${params.status}" не разрешён в справочнике ${lookupInfo.lookupCollection}.${lookupInfo.displayColumn} (matchCount=${lookupResult.matchCount}).`,
            400,
            collection,
            undefined,
            lookupResult.candidates.map((c) => c.displayValue),
            [
              `Запросите доступные значения: bpm_get_records(${lookupInfo.lookupCollection}, select='Id,${lookupInfo.displayColumn}').`,
            ]
          );
        }

        await services.odataClient.updateRecord(collection, params.id, {
          [statusField.name]: lookupResult.id,
        });

        return {
          content: [
            {
              type: 'text',
              text: `Статус ${collection}(${params.id}) установлен: ${statusField.name} = "${params.status}" (${lookupResult.id}).`,
            },
          ],
          structuredContent: {
            collection,
            id: params.id,
            status_field: statusField.name,
            status_id: lookupResult.id,
            status_value: params.status,
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
