import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceContainer } from '../tools/init-tool.js';
import { getTool } from '../tools/registry.js';
import { notInitialized } from '../tools/_guards.js';
import { formatToolError } from '../utils/errors.js';
import { DISPLAY_CANDIDATES } from '../utils/display.js';
import { containsExpression } from '../utils/odata.js';
import { normalizeName } from '../utils/name-normalize.js';
import { canonicalCollection, presentRecords, readSelect } from '../read/record-presentation.js';
import { buildNextCursor } from '../utils/cursor.js';
import { getAuthCacheScope } from '../auth/request-context.js';

const DEFAULT_COLLECTIONS = ['Contact', 'Account', 'Lead', 'Opportunity'];

export function registerSearchUnifiedTool(server: McpServer, services: ServiceContainer): void {
  const meta = getTool('bpm_search_unified');
  server.registerTool(
    meta.name,
    {
      title: meta.title,
      description: meta.description,
      annotations: meta.annotations,
      inputSchema: {
        query: z.string().trim().min(1).max(256),
        collections: z.array(z.string().min(1).max(256)).max(12).optional(),
        top: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Количество показанных записей на коллекцию; реальные количества возвращаются отдельно'),
      },
      outputSchema: {
        query: z.string(),
        count: z.number().int(),
        total_found: z.number().int().nullable(),
        has_more: z.boolean(),
        complete: z.boolean(),
        results: z.array(
          z.object({
            collection: z.string(),
            id: z.string(),
            name: z.string(),
            match_type: z.enum(['contains', 'core']),
            display_record: z.record(z.string(), z.unknown()),
          })
        ),
        counts_by_collection: z.record(z.string(), z.number().nullable()),
        cursors_by_collection: z.record(z.string(), z.string()),
        skipped: z.array(z.string()),
        errors: z.array(z.object({ collection: z.string(), code: z.string(), message: z.string() })),
        warnings: z.array(z.string()),
      },
    },
    async (params): Promise<CallToolResult> => {
      if (!services.initialized) return notInitialized();
      try {
        await services.authManager.ensureAuthenticated();
        const top = params.top ?? 5;
        const requested = [...new Set(params.collections?.length ? params.collections : DEFAULT_COLLECTIONS)];
        const query = normalizeName(params.query);
        const results: Array<{
          collection: string;
          id: string;
          name: string;
          match_type: 'contains' | 'core';
          display_record: Record<string, unknown>;
        }> = [];
        const counts: Record<string, number | null> = {};
        const cursors: Record<string, string> = {};
        const skipped: string[] = [];
        const errors: Array<{ collection: string; code: string; message: string }> = [];
        const warnings: string[] = [];
        const seen = new Set<string>();
        let hasMore = false;
        for (const raw of requested) {
          let collection = raw;
          try {
            collection = await canonicalCollection(services, raw);
            if (seen.has(collection)) continue;
            seen.add(collection);
            const metadata = await services.metadataManager.getEntityMetadata(collection);
            const nameField = DISPLAY_CANDIDATES.find((name) =>
              metadata.properties.some((p) => p.name === name && p.type === 'Edm.String')
            );
            if (!nameField)
              throw new Error('В коллекции нет строкового поля Name, Title или Number для поиска');
            const select = await readSelect(services, collection);
            let filter = containsExpression(nameField, query.normalized, services.config.odata_version, {
              caseInsensitive: true,
            });
            const fetch = () =>
              services.odataClient.getRecords<Record<string, unknown>>(
                collection,
                { $filter: filter, $select: select, $top: top + 1, $count: true, $orderby: 'Id asc' },
                false,
                top
              );
            let page = await fetch();
            let matchType: 'contains' | 'core' = 'contains';
            if (page.value.length === 0 && query.core && query.core !== query.normalized) {
              matchType = 'core';
              filter = containsExpression(nameField, query.core, services.config.odata_version, {
                caseInsensitive: true,
              });
              page = await fetch();
            }
            warnings.push(...(page.warnings ?? []));
            let total: number | null = page['@odata.count'] ?? null;
            if (total === null) {
              try {
                total = await services.odataClient.getCount(collection, filter, warnings);
              } catch {
                warnings.push(
                  `Общее количество ${collection} недоступно; показана только полученная страница.`
                );
              }
            }
            counts[collection] = total;
            const nextLink = page['@odata.nextLink'];
            const more = Boolean(nextLink) || (total !== null && total > page.value.length);
            hasMore ||= more;
            const cursor = buildNextCursor(
              { v: 1, collection, filter, select, orderby: 'Id asc', count: true, top, skip: 0, nextLink },
              page.value.length,
              more,
              `${services.config.bpmsoft_url}:${getAuthCacheScope() || services.config.username || ''}:records`
            );
            if (cursor) cursors[collection] = cursor;
            const presentation = await presentRecords(services, collection, page.value);
            warnings.push(...presentation.warnings);
            for (let index = 0; index < page.value.length; index++) {
              const row = page.value[index];
              results.push({
                collection,
                id: String(row.Id ?? row.id ?? ''),
                name: String(row[nameField] ?? ''),
                match_type: matchType,
                display_record: presentation.displayRecords[index],
              });
            }
          } catch (error) {
            const failure = formatToolError(error, collection);
            counts[collection] = null;
            skipped.push(collection);
            errors.push({ collection, code: failure.code, message: failure.error });
          }
        }
        const shown = results;
        const known = Object.values(counts).every((count) => count !== null);
        const total = known
          ? Object.values(counts).reduce<number>((sum, count) => sum + (count ?? 0), 0)
          : null;
        const lines = [
          `Поиск «${params.query}»: показано ${shown.length}${total === null ? ', общее количество неизвестно' : `, всего совпадений ${total}`}.`,
          ...shown.map((hit) => `• [${hit.collection}] ${hit.name} — ${hit.id}`),
          ...(hasMore ? ['Есть продолжение: cursors_by_collection передаются в bpm_get_records.'] : []),
          ...errors.map((error) => `${error.collection}: ${error.message}`),
          ...warnings,
        ];
        return {
          isError: errors.length > 0,
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: {
            query: params.query,
            count: shown.length,
            total_found: total,
            has_more: hasMore,
            complete: known && errors.length === 0 && !hasMore,
            results: shown,
            counts_by_collection: counts,
            cursors_by_collection: cursors,
            skipped,
            errors,
            warnings,
          },
        };
      } catch (error) {
        const failure = formatToolError(error);
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify(failure, null, 2) }],
          structuredContent: failure as unknown as Record<string, unknown>,
        };
      }
    }
  );
}
