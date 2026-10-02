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
import { getAuthCacheScope } from '../auth/request-context.js';
import { encodeCursor, decodeCursor, type CursorState } from '../utils/cursor.js';

interface EnumCacheEntry {
  values: Array<{ id: string; name: string }>;
  capturedAt: number;
  hasMore: boolean;
  totalCount?: number;
  nextLink?: string;
}

const DEFAULT_TOP = 200;
const MAX_TOP = 1000;
const connectionCaches = new WeakMap<ServiceContainer, Map<string, EnumCacheEntry>>();

export function registerEnumTool(server: McpServer, services: ServiceContainer): void {
  let cache = connectionCaches.get(services);
  if (!cache) {
    cache = new Map<string, EnumCacheEntry>();
    connectionCaches.set(services, cache);
  }
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
          .describe(
            'Имя или caption lookup-поля. Например: ActivityCategory, Status, «Тип активности», «Статус».'
          ),
        top: z
          .number()
          .int()
          .positive()
          .max(MAX_TOP)
          .optional()
          .describe(`Число значений на странице (по умолчанию ${DEFAULT_TOP}, максимум ${MAX_TOP})`),
        cursor: z
          .string()
          .optional()
          .describe(
            'Курсор следующей страницы из предыдущего ответа. Поля collection и field остаются теми же.'
          ),
      },
      outputSchema: {
        collection: z.string(),
        field: z.string(),
        lookup_collection: z.string(),
        display_column: z.string(),
        count: z.number().int(),
        has_more: z.boolean(),
        from_cache: z.boolean(),
        total_count: z.number().int().optional(),
        next_cursor: z.string().optional(),
        cursor: z.string().optional(),
        values: z.array(z.object({ id: z.string(), name: z.string() })),
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

        const scope = `${services.config.bpmsoft_url}:${getAuthCacheScope() || services.config.username || ''}:enum:${collection}:${fieldRef.name}`;
        const state: CursorState = params.cursor
          ? decodeCursor(params.cursor, scope)
          : {
              v: 1,
              collection: lookup.lookupCollection,
              select: `Id,${lookup.displayColumn}`,
              orderby: `${lookup.displayColumn} asc,Id asc`,
              top: params.top ?? DEFAULT_TOP,
              skip: 0,
              count: true,
            };
        if (
          state.collection !== lookup.lookupCollection ||
          state.select !== `Id,${lookup.displayColumn}` ||
          state.orderby !== `${lookup.displayColumn} asc,Id asc`
        )
          throw new Error('Курсор относится к другому справочнику.');
        const top = state.top ?? DEFAULT_TOP;
        if (!Number.isSafeInteger(top) || top < 1 || top > MAX_TOP)
          throw new Error('Недопустимый размер страницы справочника.');
        const cacheKey = `${scope}:${lookup.lookupCollection}:${lookup.displayColumn}:${top}:${state.skip}:${state.nextLink || ''}`;
        const ttlMs = services.config.lookup_cache_ttl * 1000;
        const cached = cache.get(cacheKey);
        const fromCache = cached !== undefined && Date.now() - cached.capturedAt < ttlMs;

        let values: Array<{ id: string; name: string }>;
        let hasMore: boolean;
        let totalCount: number | undefined;
        let nextLink: string | undefined;
        if (fromCache) {
          values = cached.values;
          hasMore = cached.hasMore;
          totalCount = cached.totalCount;
          nextLink = cached.nextLink;
        } else {
          const response = state.nextLink
            ? await services.odataClient.getNextPage<Record<string, unknown>>(
                lookup.lookupCollection,
                state.nextLink,
                top
              )
            : await services.odataClient.getRecords<Record<string, unknown>>(
                lookup.lookupCollection,
                {
                  $select: `Id,${lookup.displayColumn}`,
                  $top: top + 1,
                  $skip: state.skip,
                  $count: true,
                  $orderby: `${lookup.displayColumn} asc,Id asc`,
                },
                true,
                top
              );
          hasMore =
            response.value.length > top ||
            !!response['@odata.nextLink'] ||
            (response['@odata.count'] !== undefined &&
              response['@odata.count'] > state.skip + response.value.length);
          totalCount = response['@odata.count'];
          nextLink = response['@odata.nextLink'];
          values = response.value.slice(0, top).map((r) => ({
            id: String(r.Id ?? r.id ?? ''),
            name: String(r[lookup.displayColumn] ?? ''),
          }));
          if (cache.size >= 1000) cache.delete(cache.keys().next().value!);
          cache.set(cacheKey, { values, hasMore, totalCount, nextLink, capturedAt: Date.now() });
        }

        const lines = [
          `Поле: ${collection}.${fieldRef.name}`,
          `Справочник: ${lookup.lookupCollection} (отображение по ${lookup.displayColumn})`,
          `Значений на странице: ${values.length}${totalCount !== undefined ? ` из ${totalCount}` : ''}${hasMore ? ' (есть продолжение)' : ''}${fromCache ? ' [кеш]' : ''}`,
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
            has_more: hasMore,
            from_cache: fromCache,
            total_count: totalCount,
            next_cursor: hasMore
              ? encodeCursor({ ...state, skip: state.skip + values.length, nextLink }, scope)
              : undefined,
            cursor: hasMore
              ? encodeCursor({ ...state, skip: state.skip + values.length, nextLink }, scope)
              : undefined,
            values,
          },
        };
      } catch (error) {
        const toolError = formatToolError(error, params.collection);
        return {
          content: [{ type: 'text', text: JSON.stringify(toolError, null, 2) }],
          structuredContent: toolError as unknown as Record<string, unknown>,
          isError: true,
        };
      }
    }
  );
}

function formatErr(payload: {
  error: string;
  collection?: string;
  suggestions?: string[];
  next_steps?: string[];
}): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ success: false, ...payload }, null, 2) }],
    structuredContent: { success: false, ...payload },
    isError: true,
  };
}
