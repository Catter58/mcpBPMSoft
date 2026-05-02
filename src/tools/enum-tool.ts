/**
 * MCP Tool: bpm_get_enum_values
 *
 * Для указанной коллекции и lookup-поля возвращает все значения справочника,
 * к которому ссылается это поле. Например, Activity.ActivityCategory →
 * список всех ActivityCategory из БД (Id + Name).
 *
 * Кеширование: пара (entity, field) → результат, TTL = lookup_cache_ttl.
 */

import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceContainer } from './init-tool.js';
import { formatToolError, UnknownFieldError } from '../utils/errors.js';
import { getTool } from './registry.js';
import { notInitialized } from './_guards.js';

interface EnumCacheEntry {
  values: Array<{ id: string; name: string }>;
  capturedAt: number;
}

const CACHE = new Map<string, EnumCacheEntry>();
const DEFAULT_TOP = 200;

export function registerEnumTool(server: McpServer, services: ServiceContainer): void {
  const meta = getTool('bpm_get_enum_values');
  server.registerTool(
    meta.name,
    {
      title: meta.title,
      description: meta.description,
      inputSchema: {
        collection: z.string().describe('Имя коллекции (EntitySet), например: Activity, Lead, Opportunity'),
        field: z
          .string()
          .describe('Имя или caption lookup-поля. Например: ActivityCategory, Status, «Тип активности», «Статус».'),
        top: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Максимум значений (по умолчанию ${DEFAULT_TOP}, ограничено лимитами BPMSoft)`),
      },
      annotations: meta.annotations,
    },
    async (params): Promise<CallToolResult> => {
      if (!services.initialized) return notInitialized();
      try {
        await services.authManager.ensureAuthenticated();

        const collRef = await services.metadataManager.resolveCollectionReference(params.collection);
        if (collRef.name === null) {
          return formatErr({
            error: `Коллекция "${params.collection}" не найдена.`,
            collection: params.collection,
            suggestions: collRef.suggestions,
            next_steps: ['Запросите список коллекций: bpm_get_collections.'],
          });
        }
        const collection = collRef.name;

        const fieldRef = await services.metadataManager.resolveFieldReference(collection, params.field);
        if (fieldRef.name === null) {
          throw new UnknownFieldError(params.field, collection, fieldRef.suggestions);
        }

        const lookup = await services.metadataManager.getLookupInfo(collection, fieldRef.name);
        if (!lookup) {
          return formatErr({
            error: `Поле "${fieldRef.name}" в коллекции "${collection}" не является lookup-полем — у него нет справочника.`,
            collection,
            next_steps: [
              `Запросите схему коллекции: bpm_get_schema(${collection}).`,
              'Используйте bpm_get_enum_values только с полями, у которых isLookup=true.',
            ],
          });
        }

        const top = params.top ?? DEFAULT_TOP;
        const cacheKey = `${lookup.lookupCollection}:${lookup.displayColumn}:${top}`;
        const ttlMs = services.config.lookup_cache_ttl * 1000;
        const cached = CACHE.get(cacheKey);
        const fromCache = cached !== undefined && Date.now() - cached.capturedAt < ttlMs;

        let values: Array<{ id: string; name: string }>;
        if (fromCache) {
          values = cached.values;
        } else {
          const response = await services.odataClient.getRecords<Record<string, unknown>>(lookup.lookupCollection, {
            $select: `Id,${lookup.displayColumn}`,
            $top: top,
            $orderby: `${lookup.displayColumn} asc`,
          });
          values = response.value.map((r) => ({
            id: String(r.Id ?? r.id ?? ''),
            name: String(r[lookup.displayColumn] ?? ''),
          }));
          CACHE.set(cacheKey, { values, capturedAt: Date.now() });
        }

        const lines = [
          `Поле: ${collection}.${fieldRef.name}`,
          `Справочник: ${lookup.lookupCollection} (отображение по ${lookup.displayColumn})`,
          `Значений: ${values.length}${values.length === top ? ' (возможно, есть ещё — увеличьте top)' : ''}${fromCache ? ' [кеш]' : ''}`,
          '',
          ...values.map((v) => `  - ${v.name} (${v.id})`),
        ];

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: {
            collection,
            field: fieldRef.name,
            lookup_collection: lookup.lookupCollection,
            display_column: lookup.displayColumn,
            count: values.length,
            from_cache: fromCache,
            values,
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

function formatErr(payload: { error: string; collection?: string; suggestions?: string[]; next_steps?: string[] }): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ success: false, ...payload }, null, 2) }],
    isError: true,
  };
}
