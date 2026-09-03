/**
 * MCP Tool: bpm_search_unified
 *
 * Cross-collection substring search by Name. Skips collections that don't
 * exist in this instance's $metadata. Returns a flat list capped at 20.
 */

import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceContainer } from '../tools/init-tool.js';
import { formatToolError } from '../utils/errors.js';
import { getTool } from '../tools/registry.js';
import { notInitialized } from '../tools/_guards.js';
import { containsExpression } from '../utils/odata.js';
import { normalizeName } from '../utils/name-normalize.js';
import type { ODataVersion } from '../types/index.js';

const DEFAULT_COLLECTIONS = ['Contact', 'Account', 'Lead', 'Opportunity'];
const RESULTS_CAP = 20;

interface UnifiedHit {
  collection: string;
  id: string;
  name: string;
  match_type: 'contains' | 'core';
}

interface CollectionFetcher {
  (filter: string): Promise<Array<Record<string, unknown>>>;
}

/**
 * Поддержка tolower() — свойство инстанса, а не вызова: сервер пришпилен к одному
 * BPMSOFT_URL, поэтому запоминаем отказ на весь процесс и не тратим лишний 4xx
 * round-trip на каждый поиск.
 */
const tolowerState = { tolowerUnsupported: false };

/**
 * contains по значению с tolower(); при 4xx повторяет case-sensitive.
 */
async function fetchContains(
  fetcher: CollectionFetcher,
  value: string,
  version: ODataVersion
): Promise<Array<Record<string, unknown>>> {
  if (!tolowerState.tolowerUnsupported) {
    try {
      return await fetcher(containsExpression('Name', value, version, { caseInsensitive: true }));
    } catch (error) {
      const status = (error as { httpStatus?: number }).httpStatus;
      if (status === undefined || status < 400 || status >= 500) throw error;
      tolowerState.tolowerUnsupported = true;
      console.error('[bpm_search_unified] tolower() отклонён сервером, перехожу на case-sensitive contains');
    }
  }
  return fetcher(containsExpression('Name', value, version));
}

export function registerSearchUnifiedTool(server: McpServer, services: ServiceContainer): void {
  const meta = getTool('bpm_search_unified');
  server.registerTool(
    meta.name,
    {
      title: meta.title,
      description: meta.description,
      inputSchema: {
        query: z.string().describe('Текст для поиска (подстрока в Name)'),
        collections: z
          .array(z.string())
          .optional()
          .describe(
            `Список коллекций для поиска (по умолчанию: ${DEFAULT_COLLECTIONS.join(', ')}). Несуществующие пропускаются.`
          ),
        top: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Сколько записей выбирать в каждой коллекции (по умолчанию 5).'),
      },
      outputSchema: {
        query: z.string(),
        count: z.number().int(),
        total_found: z.number().int(),
        has_more: z.boolean(),
        results: z.array(
          z.object({
            collection: z.string(),
            id: z.string(),
            name: z.string(),
            match_type: z.enum(['contains', 'core']),
          })
        ),
        counts_by_collection: z.record(z.string(), z.number()),
        skipped: z.array(z.string()).optional(),
      },
      annotations: meta.annotations,
    },
    async (params): Promise<CallToolResult> => {
      if (!services.initialized) return notInitialized();
      try {
        await services.authManager.ensureAuthenticated();

        const requested = params.collections && params.collections.length > 0
          ? params.collections
          : DEFAULT_COLLECTIONS;
        const top = params.top ?? 5;
        const query = normalizeName(params.query);
        const version = services.config.odata_version;

        const existingSets = await services.metadataManager.getEntitySets();
        const existingNames = new Set(existingSets.map((s) => s.name));

        const results: UnifiedHit[] = [];
        const countsByCollection: Record<string, number> = {};
        const skipped: string[] = [];

        for (const coll of requested) {
          if (!existingNames.has(coll)) {
            skipped.push(coll);
            continue;
          }
          try {
            const fetcher: CollectionFetcher = async (filter) => {
              const response = await services.odataClient.getRecords<Record<string, unknown>>(coll, {
                $filter: filter,
                $top: top,
                $select: 'Id,Name',
              });
              return response.value;
            };

            let matchType: 'contains' | 'core' = 'contains';
            let records = await fetchContains(fetcher, query.normalized, version);
            if (records.length === 0 && query.core !== query.normalized) {
              matchType = 'core';
              records = await fetchContains(fetcher, query.core, version);
            }

            const hits = records.map((rec) => ({
              collection: coll,
              id: String(rec.Id ?? rec.id ?? ''),
              name: String(rec.Name ?? ''),
              match_type: matchType,
            }));
            results.push(...hits);
            countsByCollection[coll] = hits.length;
          } catch (e) {
            // Tolerate per-collection errors so a single broken entity doesn't kill the search
            countsByCollection[coll] = 0;
            skipped.push(`${coll} (ошибка: ${e instanceof Error ? e.message : String(e)})`);
          }
        }

        const capped = results.slice(0, RESULTS_CAP);
        const hasMore = results.length > RESULTS_CAP;

        return {
          content: [
            {
              type: 'text',
              text: [
                `Поиск "${params.query}" завершён. Совпадений: ${capped.length}${hasMore ? ` (показано ${RESULTS_CAP} из ${results.length})` : ''}.`,
                ...capped.map((h) => `  • [${h.collection}] ${h.name} — ${h.id}${h.match_type === 'core' ? ' (по ядру имени)' : ''}`),
                skipped.length ? `\nПропущено: ${skipped.join(', ')}` : '',
              ].filter(Boolean).join('\n'),
            },
          ],
          structuredContent: {
            query: params.query,
            count: capped.length,
            total_found: results.length,
            has_more: hasMore,
            results: capped,
            counts_by_collection: countsByCollection,
            ...(skipped.length ? { skipped } : {}),
          },
        };
      } catch (error) {
        const toolError = formatToolError(error);
        return {
          content: [{ type: 'text', text: JSON.stringify(toolError, null, 2) }],
          isError: true,
        };
      }
    }
  );
}
