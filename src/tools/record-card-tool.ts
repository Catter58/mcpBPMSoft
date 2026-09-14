/**
 * MCP Tool: bpm_record_card
 *
 * Карточка 360°: запись и всё, что к ней привязано, одним вызовом. Раньше модель
 * собирала это цепочкой get_record + по search_records на каждый связанный объект
 * и сама угадывала имена полей связи. Сервер находит их по метаданным, опрашивает
 * разделы параллельно и отдаёт компактную сводку без пустых полей и служебных колонок.
 */

import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceContainer } from './init-tool.js';
import { formatToolError } from '../utils/errors.js';
import { getTool } from './registry.js';
import { notInitialized, resolveCollectionName, resolveRecordId } from './_guards.js';
import { guidLiteral } from '../utils/odata.js';
import {
  getDisplayColumn,
  getRecordWithLookupNames,
  getRecordsWithLookupNames,
  displayKeyFor,
} from '../utils/display.js';

/** Деловые объекты, которые обычно ссылаются на контакт/контрагента. Отсутствующие пропускаются. */
const RELATED_CANDIDATES = [
  'Activity',
  'Opportunity',
  'Case',
  'Lead',
  'Contract',
  'Invoice',
  'Order',
  'Project',
  'Document',
];
const NOISE_COLUMNS = new Set(['ProcessListeners', 'Data', 'MailHash', 'HeaderProperties']);
const EMPTY_GUID = '00000000-0000-0000-0000-000000000000';

/**
 * Только содержательные поля: без @odata.*, служебных колонок, вложенных объектов и значений
 * «по умолчанию» (null, '', нулевой guid, 0001-01-01, false, 0). Uuid связи убирается, если
 * рядом есть её имя (CreatedById при CreatedByName) — полная запись есть в bpm_get_record.
 */
export function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  const isDefault = (value: unknown) =>
    value === null ||
    value === undefined ||
    value === '' ||
    value === false ||
    value === 0 ||
    value === EMPTY_GUID ||
    (typeof value === 'string' && value.startsWith('0001-01-01'));
  return Object.fromEntries(
    Object.entries(record).filter(
      ([key, value]) =>
        !key.startsWith('@odata.') &&
        !NOISE_COLUMNS.has(key) &&
        typeof value !== 'object' &&
        !isDefault(value) &&
        !(key.endsWith('Id') && key !== 'Id' && !isDefault(record[displayKeyFor(key)]))
    )
  );
}

interface SectionItem {
  id: string;
  name: string;
  created: string | null;
}

interface Section {
  collection: string;
  field: string;
  total: number;
  items: SectionItem[];
}

const sectionShape = z.object({
  collection: z.string(),
  field: z.string(),
  total: z.number().int(),
  items: z.array(z.object({ id: z.string(), name: z.string(), created: z.string().nullable() })),
});

export function registerRecordCardTool(server: McpServer, services: ServiceContainer): void {
  const meta = getTool('bpm_record_card');
  server.registerTool(
    meta.name,
    {
      title: meta.title,
      description: meta.description,
      inputSchema: {
        collection: z.string().describe('Коллекция записи: имя (Contact, Account) или русское название'),
        id: z.string().describe('UUID записи или её название (Name/Title) — Id сервер найдёт сам'),
        related_limit: z
          .number()
          .int()
          .positive()
          .max(50)
          .optional()
          .describe('Сколько последних записей показывать в каждом разделе (по умолчанию 5)'),
      },
      outputSchema: {
        collection: z.string(),
        id: z.string(),
        name: z.string(),
        record: z.record(z.string(), z.unknown()),
        related: z.array(sectionShape),
        files: sectionShape.optional(),
        tags: z.array(z.string()).optional(),
        feed: sectionShape.optional(),
        skipped: z.array(z.string()),
      },
      annotations: meta.annotations,
    },
    async (params): Promise<CallToolResult> => {
      if (!services.initialized) return notInitialized();
      try {
        await services.authManager.ensureAuthenticated();
        const collection = await resolveCollectionName(services, params.collection);
        const { id } = await resolveRecordId(services, collection, params.id);
        const limit = params.related_limit ?? 5;
        const version = services.config.odata_version;
        const entity = collection.replace(/Collection$/, '');
        const deps = {
          metadataManager: services.metadataManager,
          odataClient: services.odataClient,
          odataVersion: version,
        };

        const record = await getRecordWithLookupNames(deps, collection, id, {}, { resolveLookups: true });
        const displayColumn = (await getDisplayColumn(services.metadataManager, collection)) ?? 'Id';
        const name = String(record[displayColumn] ?? id);
        const existing = new Set((await services.metadataManager.getEntitySets()).map((s) => s.name));
        const skipped: string[] = [];

        /** Поле в `source`, ссылающееся на нашу коллекцию (в порядке `preferred`), и его навигация. */
        const linkField = async (source: string, preferred: string[]) => {
          if (!existing.has(source)) return null;
          const sourceMeta = await services.metadataManager.getEntityMetadata(source);
          const refs = sourceMeta.properties.filter((p) => p.isLookup && p.lookupCollection === collection);
          const prop = preferred.map((n) => refs.find((p) => p.name === n)).find(Boolean);
          if (!prop) return null;
          return { field: prop.name, nav: prop.lookupNavProperty ?? prop.name.replace(/Id$/, '') };
        };

        const querySection = async (
          source: string,
          link: { field: string; nav: string },
          display: string
        ): Promise<Section> => {
          const response = await services.odataClient.getRecords<Record<string, unknown>>(source, {
            $filter: `${link.nav}/Id eq ${guidLiteral(id, version)}`,
            $select: `Id,${display},CreatedOn`,
            $orderby: 'CreatedOn desc',
            $top: limit,
            $count: true,
          });
          return {
            collection: source,
            field: link.field,
            total: response['@odata.count'] ?? response.value.length,
            items: response.value.map((r) => ({
              id: String(r.Id),
              name: String(r[display] ?? r.Id),
              created: (r.CreatedOn as string | null) ?? null,
            })),
          };
        };

        const guarded = async <T>(label: string, run: () => Promise<T | null>): Promise<T | null> => {
          try {
            return await run();
          } catch (error) {
            skipped.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
            return null;
          }
        };

        const relatedPromises = RELATED_CANDIDATES.filter((c) => c !== collection).map((source) =>
          guarded(source, async () => {
            const link = await linkField(source, [`${entity}Id`, entity]);
            if (!link) return null;
            const display = (await getDisplayColumn(services.metadataManager, source)) ?? 'Id';
            return querySection(source, link, display);
          })
        );

        const filesPromise = guarded(`${entity}File`, async () => {
          const link = await linkField(`${entity}File`, [`${entity}Id`, entity]);
          return link ? querySection(`${entity}File`, link, 'Name') : null;
        });

        const tagsPromise = guarded(`${entity}InTag`, async () => {
          const link = await linkField(`${entity}InTag`, ['EntityId', 'Entity']);
          if (!link) return null;
          const { records } = await getRecordsWithLookupNames(
            deps,
            `${entity}InTag`,
            { $filter: `${link.nav}/Id eq ${guidLiteral(id, version)}`, $select: 'Id,TagId', $top: 50 },
            { resolveLookups: true }
          );
          return records.map((r) => String(r[displayKeyFor('TagId')] ?? r.TagId));
        });

        const feedPromise = guarded('SocialMessage', async (): Promise<Section | null> => {
          if (!existing.has('SocialMessage')) return null;
          const response = await services.odataClient.getRecords<Record<string, unknown>>('SocialMessage', {
            $filter: `EntityId eq ${guidLiteral(id, version)}`,
            $select: 'Id,Message,CreatedOn',
            $orderby: 'CreatedOn desc',
            $top: limit,
            $count: true,
          });
          return {
            collection: 'SocialMessage',
            field: 'EntityId',
            total: response['@odata.count'] ?? response.value.length,
            items: response.value.map((r) => ({
              id: String(r.Id),
              name: String(r.Message ?? '')
                .replace(/<[^>]+>/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 200),
              created: (r.CreatedOn as string | null) ?? null,
            })),
          };
        });

        const [relatedRaw, files, tags, feed] = await Promise.all([
          Promise.all(relatedPromises),
          filesPromise,
          tagsPromise,
          feedPromise,
        ]);
        const related = relatedRaw.filter((s): s is Section => s !== null);
        const fields = compactRecord(record);

        const sectionLines = (title: string, s: Section) => [
          `${title}: ${s.total}`,
          ...s.items.map((i) => `  - ${i.name}${i.created ? ` (${i.created.slice(0, 10)})` : ''} — ${i.id}`),
        ];
        const lines = [
          `Карточка ${collection} «${name}» (${id})`,
          '',
          ...Object.entries(fields).map(([k, v]) => `  ${k}: ${v}`),
          '',
          ...related
            .filter((s) => s.total > 0)
            .flatMap((s) => sectionLines(`${s.collection} по полю ${s.field}`, s)),
          ...(related.some((s) => s.total === 0)
            ? [
                `Пусто: ${related
                  .filter((s) => s.total === 0)
                  .map((s) => s.collection)
                  .join(', ')}`,
              ]
            : []),
          ...(files ? sectionLines('Файлы', files) : []),
          ...(tags ? [`Теги: ${tags.length ? tags.join(', ') : 'нет'}`] : []),
          ...(feed ? sectionLines('Лента', feed) : []),
          ...(skipped.length ? ['', `Пропущено: ${skipped.join('; ')}`] : []),
        ];

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: {
            collection,
            id,
            name,
            record: fields,
            related,
            ...(files ? { files } : {}),
            ...(tags ? { tags } : {}),
            ...(feed ? { feed } : {}),
            skipped,
          },
        };
      } catch (error) {
        const toolError = formatToolError(error, params.collection);
        return { content: [{ type: 'text', text: JSON.stringify(toolError, null, 2) }], isError: true };
      }
    }
  );
}
