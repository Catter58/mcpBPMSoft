import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceContainer } from '../tools/init-tool.js';
import { getTool } from '../tools/registry.js';
import { notInitialized } from '../tools/_guards.js';
import { formatToolError } from '../utils/errors.js';
import { DISPLAY_CANDIDATES } from '../utils/display.js';
import { containsExpression, escapeODataString } from '../utils/odata.js';
import { normalizeName } from '../utils/name-normalize.js';
import {
  canonicalCollection,
  canonicalField,
  presentRecords,
  readSelect,
} from '../read/record-presentation.js';
import { buildNextCursor } from '../utils/cursor.js';
import { getAuthCacheScope } from '../auth/request-context.js';
import { isTolowerSupported } from '../utils/server-capabilities.js';
import { BpmApiError } from '../utils/errors.js';

const DEFAULT_COLLECTIONS = ['Contact', 'Account', 'Lead', 'Opportunity'];
const MAX_SEARCH_FIELDS = 8;

const fieldsByCollectionSchema = z
  .record(
    z.string().trim().min(1).max(256),
    z.array(z.string().trim().min(1).max(128)).min(1).max(MAX_SEARCH_FIELDS)
  )
  .refine((fields) => Object.keys(fields).length > 0 && Object.keys(fields).length <= 12, {
    message: 'Укажите поля не более чем для 12 коллекций.',
  });

function searchExpression(field: string, value: string, mode: 'contains' | 'exact', version: 3 | 4): string {
  const caseInsensitive = isTolowerSupported();
  const path = caseInsensitive ? `tolower(${field})` : field;
  const query = caseInsensitive ? value.toLowerCase() : value;
  if (mode === 'exact') return `${path} eq '${escapeODataString(query)}'`;
  return containsExpression(field, value, version, { caseInsensitive: true });
}

function matchesField(
  value: unknown,
  query: string,
  mode: 'contains' | 'exact',
  caseInsensitive: boolean
): boolean {
  if (typeof value !== 'string') return false;
  const left = caseInsensitive ? value.toLowerCase() : value;
  const right = caseInsensitive ? query.toLowerCase() : query;
  return mode === 'exact' ? left === right : left.includes(right);
}

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
        fields_by_collection: fieldsByCollectionSchema
          .optional()
          .describe(
            'Точный набор строковых полей для поиска, например {"Account":["ИНН","Name"],"Activity":["Title"]}. При отсутствии collections ключи map задают коллекции; без map сохраняется поиск по Name/Title/Number.'
          ),
        match_mode: z
          .enum(['contains', 'exact'])
          .optional()
          .describe('contains — подстрока (по умолчанию); exact — точное значение, без расширения запроса.'),
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
            match_type: z.enum(['contains', 'core', 'exact']),
            matched_fields: z.array(z.string()),
            display_record: z.record(z.string(), z.unknown()),
          })
        ),
        counts_by_collection: z.record(z.string(), z.number().nullable()),
        count_semantics: z.string(),
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
        const explicitFields = params.fields_by_collection;
        const requested = [
          ...new Set(
            params.collections?.length
              ? params.collections
              : explicitFields
                ? Object.keys(explicitFields)
                : DEFAULT_COLLECTIONS
          ),
        ];
        const query = normalizeName(params.query);
        const searchMode = params.match_mode ?? 'contains';
        const results: Array<{
          collection: string;
          id: string;
          name: string;
          match_type: 'contains' | 'core' | 'exact';
          matched_fields: string[];
          display_record: Record<string, unknown>;
        }> = [];
        const counts: Record<string, number | null> = {};
        const cursors: Record<string, string> = {};
        const skipped: string[] = [];
        const errors: Array<{ collection: string; code: string; message: string }> = [];
        const warnings: string[] = [];
        const canonicalCollections: string[] = [];
        const fieldLabelsByCollection = new Map<string, Record<string, string>>();
        for (const raw of requested) {
          try {
            const collection = await canonicalCollection(services, raw);
            if (!canonicalCollections.includes(collection)) canonicalCollections.push(collection);
          } catch (error) {
            const failure = formatToolError(error, raw);
            counts[raw] = null;
            skipped.push(raw);
            errors.push({
              collection: raw,
              code: failure.code,
              message: String(failure.error ?? 'Коллекция недоступна.'),
            });
          }
        }
        const explicitByCanonical = new Map<string, string[]>();
        if (explicitFields) {
          for (const [raw, fields] of Object.entries(explicitFields)) {
            const collection = await canonicalCollection(services, raw);
            if (explicitByCanonical.has(collection))
              throw new BpmApiError(
                `Коллекция ${collection} указана в fields_by_collection несколько раз.`,
                400,
                collection
              );
            explicitByCanonical.set(collection, fields);
          }
          const requestedSet = new Set(canonicalCollections);
          const extra = [...explicitByCanonical.keys()].find((collection) => !requestedSet.has(collection));
          if (extra)
            throw new BpmApiError(
              `fields_by_collection содержит невыбранную коллекцию ${extra}.`,
              400,
              extra
            );
          const missing = canonicalCollections.find((collection) => !explicitByCanonical.has(collection));
          if (missing)
            throw new BpmApiError(
              `Укажите search fields для каждой выбранной коллекции; отсутствует ${missing}.`,
              400,
              missing
            );
        }
        const seen = new Set<string>();
        let hasMore = false;
        for (const collection of canonicalCollections) {
          try {
            const metadata = await services.metadataManager.getEntityMetadata(collection);
            const defaultNameField = DISPLAY_CANDIDATES.find((name) =>
              metadata.properties.some((p) => p.name === name && p.type === 'Edm.String')
            );
            let searchFields: string[];
            if (explicitFields) {
              const resolved = await Promise.all(
                explicitByCanonical.get(collection)!.map(async (input) => {
                  const property = await canonicalField(services, collection, input);
                  if (property.type !== 'Edm.String')
                    throw new BpmApiError(
                      `Поле ${input} в ${collection} не является строковым; поиск не выполнен.`,
                      400,
                      collection
                    );
                  return property.name;
                })
              );
              searchFields = [...new Set(resolved)];
            } else {
              if (!defaultNameField)
                throw new BpmApiError(
                  'В коллекции нет строкового поля Name, Title или Number для поиска.',
                  400,
                  collection
                );
              searchFields = [defaultNameField];
            }
            const displayField = defaultNameField ?? searchFields[0];
            const select = await readSelect(
              services,
              collection,
              [...new Set([...searchFields, displayField])].join(',')
            );
            let activeTerm = explicitFields
              ? params.query.trim()
              : searchMode === 'exact'
                ? params.query.trim()
                : query.normalized;
            let activeMode = searchMode;
            let filter = searchFields
              .map((field) => searchExpression(field, activeTerm, activeMode, services.config.odata_version))
              .map((part) => `(${part})`)
              .join(' or ');
            const fetch = () =>
              services.odataClient.getRecords<Record<string, unknown>>(
                collection,
                { $filter: filter, $select: select, $top: top + 1, $count: true, $orderby: 'Id asc' },
                false,
                top
              );
            let page = await fetch();
            let matchType: 'contains' | 'core' | 'exact' = searchMode === 'exact' ? 'exact' : 'contains';
            if (
              !explicitFields &&
              searchMode === 'contains' &&
              page.value.length === 0 &&
              query.core &&
              query.core !== query.normalized
            ) {
              matchType = 'core';
              activeTerm = query.core;
              activeMode = 'contains';
              filter = searchFields
                .map((field) =>
                  searchExpression(field, activeTerm, activeMode, services.config.odata_version)
                )
                .map((part) => `(${part})`)
                .join(' or ');
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
            fieldLabelsByCollection.set(collection, presentation.fieldLabels);
            warnings.push(...presentation.warnings);
            const matchedTerm =
              matchType === 'core'
                ? query.core
                : explicitFields || searchMode === 'exact'
                  ? params.query.trim()
                  : query.normalized;
            const caseInsensitive = isTolowerSupported();
            for (let index = 0; index < page.value.length; index++) {
              const row = page.value[index];
              const id = String(row.Id ?? row.id ?? '');
              if (!id)
                throw new Error(
                  `Ответ ${collection} не содержит Id; результат нельзя безопасно дедуплицировать.`
                );
              const identity = `${collection.toLowerCase()}\u0000${id.toLowerCase()}`;
              if (seen.has(identity)) continue;
              seen.add(identity);
              const matchedFields = searchFields.filter((field) => {
                if (
                  (matchType === 'core' || (!explicitFields && searchMode === 'contains')) &&
                  caseInsensitive
                )
                  return (
                    typeof row[field] === 'string' &&
                    normalizeName(row[field] as string).normalized.includes(matchedTerm)
                  );
                return matchesField(row[field], matchedTerm, activeMode, caseInsensitive);
              });
              results.push({
                collection,
                id,
                name: String(row[displayField] ?? (matchedFields.length ? row[matchedFields[0]] : '') ?? ''),
                match_type: matchType,
                matched_fields: matchedFields,
                display_record: presentation.displayRecords[index],
              });
            }
          } catch (error) {
            const failure = formatToolError(error, collection);
            counts[collection] = null;
            skipped.push(collection);
            errors.push({
              collection,
              code: failure.code,
              message: String(failure.error ?? 'Поиск в коллекции не выполнен.'),
            });
          }
        }
        const shown = results;
        const known = Object.values(counts).every((count) => count !== null);
        const total = known
          ? Object.values(counts).reduce<number>((sum, count) => sum + (count ?? 0), 0)
          : null;
        const complete = known && errors.length === 0 && !hasMore;
        const countSemantics =
          'count — показанные уникальные пары (collection, Id); total_found — сумма серверных итогов по коллекциям, одинаковые Id в разных коллекциях считаются отдельно.';
        const lines = [
          `Поиск «${params.query}»: показано ${shown.length} уникальных пар (коллекция, Id)${total === null ? ', общее количество неизвестно' : `, всего совпадений по коллекциям ${total}`}.`,
          ...shown.map(
            (hit) =>
              `• [${hit.collection}] ${hit.name} — ${hit.id}; найдено по: ${
                hit.matched_fields
                  .map((field) => {
                    const label = fieldLabelsByCollection.get(hit.collection)?.[field] ?? field;
                    return label === field ? field : `${label} (${field})`;
                  })
                  .join(', ') || 'поле не удалось определить'
              }`
          ),
          ...(!complete
            ? [
                `Покрытие неполное: ${errors.length ? `ошибки в ${skipped.join(', ')}` : hasMore ? 'есть продолжение' : 'общее количество неизвестно'}.`,
              ]
            : []),
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
            complete,
            results: shown,
            counts_by_collection: counts,
            count_semantics: countSemantics,
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
