/**
 * MCP Tool: bpm_describe_instance
 *
 * Возвращает краткую сводку по инстансу BPMSoft за один вызов:
 *   - общее число EntitySet-ов;
 *   - какие из основных бизнес-сущностей присутствуют (Contact, Account, ...) с
 *     каунтами полей/lookup-ов/кастомных Usr*-полей и числом записей;
 *   - сколько и какие кастомные (Usr*) коллекции есть.
 *
 * Результат кешируется на 5 минут — повторные вызовы в этом окне не дёргают
 * metadataManager / odataClient.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceContainer } from './init-tool.js';
import type { EntityMetadata } from '../types/index.js';
import { formatToolError } from '../utils/errors.js';
import { getTool } from './registry.js';
import { notInitialized } from './_guards.js';

const MAIN_ENTITY_CANDIDATES = [
  'Contact',
  'Account',
  'Activity',
  'Lead',
  'Opportunity',
  'Order',
  'Case',
] as const;

const CACHE_TTL_MS = 5 * 60 * 1000;
const CUSTOM_SAMPLE_LIMIT = 30;
const CUSTOM_FIELDS_SAMPLE_LIMIT = 10;

interface MainEntitySummary {
  name: string;
  caption: string | null;
  total_fields: number;
  lookup_fields: number;
  custom_fields_count: number;
  custom_fields_sample: string[];
  record_count: number | null;
}

interface InstanceSummary {
  collections_total: number;
  custom_collections_total: number;
  custom_collections_sample: string[];
  main_entities: MainEntitySummary[];
  generated_at: number;
}

interface CacheEntry {
  summary: InstanceSummary;
  createdAt: number;
}

export function registerDescribeInstanceTool(server: McpServer, services: ServiceContainer): void {
  const meta = getTool('bpm_describe_instance');
  let cache: CacheEntry | null = null;

  server.registerTool(
    meta.name,
    {
      title: meta.title,
      description: meta.description,
      inputSchema: {},
      annotations: meta.annotations,
    },
    async (): Promise<CallToolResult> => {
      if (!services.initialized) return notInitialized();
      try {
        const now = Date.now();
        if (cache && now - cache.createdAt <= CACHE_TTL_MS) {
          return buildResult(cache.summary, true);
        }

        await services.authManager.ensureAuthenticated();

        const entitySets = await services.metadataManager.getEntitySets();
        const setNames = new Set(entitySets.map((s) => s.name));

        const presentMainEntities = MAIN_ENTITY_CANDIDATES.filter((name) => setNames.has(name));

        const mainEntities: MainEntitySummary[] = await Promise.all(
          presentMainEntities.map(async (name) => buildMainEntitySummary(services, name))
        );

        const customCollections = entitySets
          .map((s) => s.name)
          .filter((n) => n.startsWith('Usr'));

        const summary: InstanceSummary = {
          collections_total: entitySets.length,
          custom_collections_total: customCollections.length,
          custom_collections_sample: customCollections.slice(0, CUSTOM_SAMPLE_LIMIT),
          main_entities: mainEntities,
          generated_at: now,
        };

        cache = { summary, createdAt: now };
        return buildResult(summary, false);
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

async function buildMainEntitySummary(
  services: ServiceContainer,
  name: string
): Promise<MainEntitySummary> {
  let metadata: EntityMetadata | null = null;
  try {
    metadata = await services.metadataManager.getEntityMetadata(name);
  } catch (error) {
    console.error(`[bpm_describe_instance] getEntityMetadata("${name}") failed:`, error);
  }

  let recordCount: number | null = null;
  try {
    recordCount = await services.odataClient.getCount(name);
  } catch (error) {
    console.error(`[bpm_describe_instance] getCount("${name}") failed:`, error);
    recordCount = null;
  }

  if (!metadata) {
    return {
      name,
      caption: null,
      total_fields: 0,
      lookup_fields: 0,
      custom_fields_count: 0,
      custom_fields_sample: [],
      record_count: recordCount,
    };
  }

  const customFields = metadata.properties.filter((p) => p.name.startsWith('Usr'));
  // Сущности нет caption-а напрямую — fallback на metadata.name
  const captionProp = metadata.properties.find((p) => p.name === metadata!.name);
  const caption = captionProp?.caption ?? metadata.name ?? null;

  return {
    name,
    caption,
    total_fields: metadata.properties.length,
    lookup_fields: metadata.lookupFields.length,
    custom_fields_count: customFields.length,
    custom_fields_sample: customFields.slice(0, CUSTOM_FIELDS_SAMPLE_LIMIT).map((p) => p.name),
    record_count: recordCount,
  };
}

function buildResult(summary: InstanceSummary, fromCache: boolean): CallToolResult {
  const lines: string[] = [];
  lines.push('Инстанс');
  lines.push(`  Всего коллекций: ${summary.collections_total}`);
  lines.push(`  Кастомных (Usr*) коллекций: ${summary.custom_collections_total}`);
  if (fromCache) {
    const ageSec = Math.round((Date.now() - summary.generated_at) / 1000);
    lines.push(`  (из кеша, возраст ~${ageSec} c)`);
  }
  lines.push('');

  lines.push('Основные сущности');
  if (summary.main_entities.length === 0) {
    lines.push('  (ни одна из Contact/Account/Activity/Lead/Opportunity/Order/Case не найдена)');
  } else {
    for (const e of summary.main_entities) {
      const recPart = e.record_count === null ? 'count: n/a' : `${e.record_count} записей`;
      const customPart = e.custom_fields_count > 0 ? `, кастомных полей: ${e.custom_fields_count}` : '';
      lines.push(`  - ${e.name}: ${recPart}, полей: ${e.total_fields} (lookup: ${e.lookup_fields})${customPart}`);
      if (e.custom_fields_sample.length > 0) {
        lines.push(`      Usr*: ${e.custom_fields_sample.join(', ')}`);
      }
    }
  }
  lines.push('');

  lines.push('Кастомные коллекции');
  if (summary.custom_collections_total === 0) {
    lines.push('  (нет)');
  } else {
    const shown = summary.custom_collections_sample.join(', ');
    const more =
      summary.custom_collections_total > summary.custom_collections_sample.length
        ? ` (и ещё ${summary.custom_collections_total - summary.custom_collections_sample.length})`
        : '';
    lines.push(`  ${shown}${more}`);
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    structuredContent: {
      collections_total: summary.collections_total,
      custom_collections_total: summary.custom_collections_total,
      custom_collections_sample: summary.custom_collections_sample,
      main_entities: summary.main_entities,
      generated_at: summary.generated_at,
      from_cache: fromCache,
    },
  };
}
