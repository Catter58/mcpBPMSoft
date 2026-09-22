/**
 * MCP Tools: дедупликация
 *
 * bpm_find_duplicates  — группы дублей по всей коллекции (или по условию)
 * bpm_check_duplicates — есть ли уже такая запись, до создания
 * bpm_merge_duplicates — план слияния → подтверждение → заполнение полей, перепривязка ссылок, удаление
 *
 * Встроенные сервисы дедупликации BPMSoft на стендах недоступны (404), а
 * таблицы ContactDuplicate/AccountDuplicate пусты, поэтому всё считает сервер MCP:
 * данные тянутся постранично, сравнение и кластеризация — в src/dedup/*, связи для
 * перепривязки — из графа схемы (MetadataManager.getLookupGraph).
 */

import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceContainer } from './init-tool.js';
import type { EntityMetadata } from '../types/index.js';
import { formatToolError, isQueryUnsupportedError } from '../utils/errors.js';
import { getTool } from './registry.js';
import {
  notInitialized,
  resolveCollectionName,
  resolveRecordId,
  compileCriteria,
  combineFilters,
} from './_guards.js';
import { criterionSchema } from './_schemas.js';
import { getDisplayColumn } from '../utils/display.js';
import { containsExpression, escapeODataString, guidLiteral, isSafeIdentifier } from '../utils/odata.js';
import { isTolowerSupported, markTolowerUnsupported } from '../utils/server-capabilities.js';
import { confirmParam, confirmationRequired } from '../utils/confirm.js';
import type { Criterion } from '../utils/filter-compiler.js';
import type { DedupKind, DedupRecord, DuplicateLevel, DuplicatePair } from '../dedup/types.js';
import {
  findDuplicatePairs,
  clusterPairs,
  matchAgainst,
  suggestMaster,
  LEVEL_THRESHOLDS,
} from '../dedup/detect.js';
import {
  normalizePhone,
  normalizeDomain,
  normalizeInn,
  normalizeOrgName,
  normalizePersonName,
} from '../dedup/normalize.js';

const PAGE_SIZE = 1000;
const DEFAULT_MAX_RECORDS = 20000;
const MAX_RECORDS_CAP = 100000;
const EMPTY_GUID = '00000000-0000-0000-0000-000000000000';
const LEVELS = ['exact', 'likely', 'possible'] as const;
/** Сколько записей из найденных групп дополнительно опрашивать на число связанных. */
const RELATED_COUNT_CAP = 60;
/** Деловые объекты, по числу ссылок из которых выбирается основная запись группы. */
const BUSINESS_SOURCES = [
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
/** Колонки, которые при слиянии не переносятся: служебные и вычисляемые платформой. */
const NON_MERGEABLE = new Set([
  'Id',
  'CreatedOn',
  'CreatedById',
  'ModifiedOn',
  'ModifiedById',
  'ProcessListeners',
  'Completeness',
]);

// ---------------------------------------------------------------------------
// Профиль коллекции: какие колонки чем являются
// ---------------------------------------------------------------------------

export interface DedupProfile {
  collection: string;
  entity: string;
  kind: DedupKind;
  nameField?: string;
  emailFields: string[];
  phoneFields: string[];
  innField?: string;
  websiteField?: string;
  accountField?: string;
  birthField?: string;
  communication?: { collection: string; field: string; nav: string };
}

/** Строит профиль по метаданным: под стенд ничего не зашито, кроме типовых имён колонок. */
export function buildProfile(
  collection: string,
  meta: EntityMetadata,
  displayColumn: string | null,
  communication?: DedupProfile['communication']
): DedupProfile {
  const entity = collection.replace(/Collection$/, '');
  const strings = meta.properties.filter((p) => p.type === 'Edm.String').map((p) => p.name);
  const has = (name: string) => meta.properties.some((p) => p.name === name);
  const kind: DedupKind =
    entity === 'Contact' || entity === 'Employee' || entity === 'Lead'
      ? 'person'
      : entity === 'Account'
        ? 'organization'
        : 'generic';

  // У лида ФИО контакта — текстовое поле Contact, а LeadName — название самого лида.
  const nameField =
    entity === 'Lead' && strings.includes('Contact') ? 'Contact' : (displayColumn ?? undefined);

  return {
    collection,
    entity,
    kind,
    nameField,
    emailFields: strings.filter((n) => /email/i.test(n) && !/^(DoNotUse|IsNon|Is)/.test(n)),
    phoneFields: strings.filter((n) => /phone/i.test(n) && !/^(DoNotUse|Is)/.test(n)),
    innField: strings.find((n) => /^(usr)?(inn|taxpayerid|taxid)$/i.test(n) || /Inn$/.test(n)),
    websiteField: strings.find((n) => /^(web|website|site|url)$/i.test(n)),
    accountField: kind === 'person' && has('AccountId') ? 'AccountId' : undefined,
    birthField: has('BirthDate') ? 'BirthDate' : undefined,
    communication,
  };
}

function profileColumns(profile: DedupProfile): string[] {
  return [
    'Id',
    'CreatedOn',
    profile.nameField,
    ...profile.emailFields,
    ...profile.phoneFields,
    profile.innField,
    profile.websiteField,
    profile.accountField,
    profile.birthField,
  ].filter((c): c is string => typeof c === 'string' && isSafeIdentifier(c));
}

function isDefaultValue(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === '' ||
    value === EMPTY_GUID ||
    (typeof value === 'string' && value.startsWith('0001-01-01'))
  );
}

/** Запись CRM (+ её средства связи) → вход детектора. */
export function toDedupRecord(
  row: Record<string, unknown>,
  profile: DedupProfile,
  extraNumbers: string[] = []
): DedupRecord {
  const text = (field?: string) => {
    const value = field ? row[field] : undefined;
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  };
  const emails = new Set<string>();
  const phones = new Set<string>();
  for (const raw of [...profile.emailFields.map(text), ...extraNumbers]) {
    if (raw && raw.includes('@')) emails.add(raw);
  }
  for (const raw of [...profile.phoneFields.map(text), ...extraNumbers]) {
    if (raw && !raw.includes('@') && (raw.match(/\d/g)?.length ?? 0) >= 7) phones.add(raw);
  }
  const website =
    text(profile.websiteField) ??
    extraNumbers.find(
      (n) => !n.includes('@') && /^(https?:\/\/)?[\w-]+(\.[\w-]+)+/i.test(n) && !/^\+?[\d\s()-]+$/.test(n)
    );

  const columns = profileColumns(profile);
  return {
    id: String(row.Id),
    kind: profile.kind,
    name: text(profile.nameField),
    emails: [...emails],
    phones: [...phones],
    inn: text(profile.innField),
    website,
    accountId:
      profile.accountField && !isDefaultValue(row[profile.accountField])
        ? String(row[profile.accountField])
        : undefined,
    birthDate:
      profile.birthField && !isDefaultValue(row[profile.birthField])
        ? String(row[profile.birthField])
        : undefined,
    createdOn: typeof row.CreatedOn === 'string' ? row.CreatedOn : undefined,
    filled: columns.filter((c) => c !== 'Id' && !isDefaultValue(row[c])).length + extraNumbers.length,
  };
}

/**
 * Какие пустые поля основной записи заполнить из дублей (первое непустое значение).
 * ponytail: числа и флаги не переносим — 0 и false неотличимы от «не заполнено»; бинарные колонки тоже.
 */
export function planFillFields(
  meta: EntityMetadata,
  master: Record<string, unknown>,
  duplicates: Array<Record<string, unknown>>
): Record<string, unknown> {
  const fill: Record<string, unknown> = {};
  for (const prop of meta.properties) {
    if (NON_MERGEABLE.has(prop.name)) continue;
    if (!['Edm.String', 'Edm.Guid', 'Edm.DateTimeOffset', 'Edm.DateTime', 'Edm.Date'].includes(prop.type))
      continue;
    if (!isDefaultValue(master[prop.name])) continue;
    const source = duplicates.find((d) => !isDefaultValue(d[prop.name]));
    if (source) fill[prop.name] = source[prop.name];
  }
  return fill;
}

async function loadProfile(services: ServiceContainer, collection: string): Promise<DedupProfile> {
  const meta = await services.metadataManager.getEntityMetadata(collection);
  const displayColumn = await getDisplayColumn(services.metadataManager, collection);
  const entity = collection.replace(/Collection$/, '');
  let communication: DedupProfile['communication'];
  try {
    const sets = new Set((await services.metadataManager.getEntitySets()).map((s) => s.name));
    const commSet = [`${entity}Communication`, `${entity}CommunicationCollection`].find((n) => sets.has(n));
    if (commSet) {
      const commMeta = await services.metadataManager.getEntityMetadata(commSet);
      const link = commMeta.properties.find((p) => p.isLookup && p.lookupCollection === collection);
      if (link && commMeta.properties.some((p) => p.name === 'Number')) {
        communication = {
          collection: commSet,
          field: link.name,
          nav: link.lookupNavProperty ?? link.name.replace(/Id$/, ''),
        };
      }
    }
  } catch {
    // Средства связи — дополнение; без них дедупликация всё равно работает.
  }
  return buildProfile(collection, meta, displayColumn, communication);
}

async function pageAll(
  services: ServiceContainer,
  collection: string,
  query: { $filter?: string; $select: string },
  maxRecords: number
): Promise<{ rows: Array<Record<string, unknown>>; truncated: boolean }> {
  const rows: Array<Record<string, unknown>> = [];
  while (rows.length < maxRecords) {
    const top = Math.min(PAGE_SIZE, maxRecords - rows.length);
    const page = await services.odataClient.getRecords<Record<string, unknown>>(collection, {
      ...query,
      $top: top,
      $skip: rows.length,
      $orderby: 'Id',
    });
    rows.push(...page.value);
    if (page.value.length < top) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

/** Номера и адреса из средств связи, сгруппированные по владельцу. */
async function loadCommunications(
  services: ServiceContainer,
  profile: DedupProfile,
  ownerIds: Set<string> | null
): Promise<Map<string, string[]>> {
  const byOwner = new Map<string, string[]>();
  if (!profile.communication) return byOwner;
  const { collection, field } = profile.communication;
  const { rows } = await pageAll(services, collection, { $select: `Id,Number,${field}` }, MAX_RECORDS_CAP);
  for (const row of rows) {
    const owner = String(row[field] ?? '');
    const number = typeof row.Number === 'string' ? row.Number.trim() : '';
    if (!number || isDefaultValue(owner) || (ownerIds && !ownerIds.has(owner))) continue;
    byOwner.set(owner, [...(byOwner.get(owner) ?? []), number]);
  }
  return byOwner;
}

/** Средства связи только для указанных владельцев (для проверки одной записи). */
async function loadCommunicationsFor(
  services: ServiceContainer,
  profile: DedupProfile,
  ownerIds: string[]
): Promise<Map<string, string[]>> {
  const byOwner = new Map<string, string[]>();
  if (!profile.communication || ownerIds.length === 0) return byOwner;
  const version = services.config.odata_version;
  const { collection, field, nav } = profile.communication;
  try {
    const page = await services.odataClient.getRecords<Record<string, unknown>>(collection, {
      $filter: ownerIds
        .slice(0, 50)
        .map((id) => `${nav}/Id eq ${guidLiteral(id, version)}`)
        .join(' or '),
      $select: `Id,Number,${field}`,
      $top: 1000,
    });
    for (const row of page.value) {
      const owner = String(row[field] ?? '');
      if (typeof row.Number === 'string' && row.Number.trim()) {
        byOwner.set(owner, [...(byOwner.get(owner) ?? []), row.Number.trim()]);
      }
    }
  } catch {
    // Без средств связи оценка чуть грубее, но проверка работает.
  }
  return byOwner;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

interface ReferenceSource {
  collection: string;
  field: string;
  /** null — колонка не lookup (SocialMessage.EntityId), фильтр по самой колонке. */
  nav: string | null;
}

/** Все места, которые ссылаются на запись коллекции: входящие lookup из графа схемы + лента. */
async function referenceSources(
  services: ServiceContainer,
  collection: string,
  businessOnly: boolean
): Promise<{ sources: ReferenceSource[]; skipped: string[] }> {
  const graph = await services.metadataManager.getLookupGraph();
  const entity = collection.replace(/Collection$/, '');
  const skipped: string[] = [];
  const sources: ReferenceSource[] = [];
  for (const edge of graph.incoming.get(collection) ?? []) {
    const source = edge.from.replace(/Collection$/, '');
    // Системные таблицы и представления через OData не пишутся; таблицы дублей переносить незачем.
    if (/^(Sys|Vw)/.test(source) || /Duplicate$/.test(source)) {
      if (!businessOnly) skipped.push(`${edge.from}.${edge.field}`);
      continue;
    }
    if (businessOnly && !BUSINESS_SOURCES.includes(source) && !source.startsWith(entity)) continue;
    sources.push({ collection: edge.from, field: edge.field, nav: edge.nav });
  }
  const sets = new Set((await services.metadataManager.getEntitySets()).map((s) => s.name));
  const feed = ['SocialMessage', 'SocialMessageCollection'].find((n) => sets.has(n));
  if (feed) sources.push({ collection: feed, field: 'EntityId', nav: null });
  return { sources, skipped };
}

function referenceFilter(source: ReferenceSource, id: string, version: 3 | 4): string {
  return source.nav
    ? `${source.nav}/Id eq ${guidLiteral(id, version)}`
    : `${source.field} eq ${guidLiteral(id, version)}`;
}

async function countReferences(
  services: ServiceContainer,
  sources: ReferenceSource[],
  ids: string[],
  listCap = 1000
): Promise<{ counts: Array<{ source: ReferenceSource; id: string; count: number }>; failed: string[] }> {
  const version = services.config.odata_version;
  const jobs = ids.flatMap((id) => sources.map((source) => ({ source, id })));
  const failed = new Set<string>();
  const results = await mapLimit(jobs, 8, async (job) => {
    const filter = referenceFilter(job.source, job.id, version);
    try {
      return { ...job, count: await services.odataClient.getCount(job.source.collection, filter) };
    } catch {
      // /$count на части таблиц падает (тестовый стенд: PostgresException), а выборка может работать — считаем ею.
      try {
        const page = await services.odataClient.getRecords<Record<string, unknown>>(job.source.collection, {
          $filter: filter,
          $select: 'Id',
          $top: listCap + 1,
        });
        return { ...job, count: page.value.length };
      } catch (error) {
        failed.add(`${job.source.collection}.${job.source.field}: не читается (${errorText(error)})`);
        return { ...job, count: 0 };
      }
    }
  });
  return { counts: results.filter((r) => r.count > 0), failed: [...failed] };
}

const levelAtLeast = (level: DuplicateLevel, min: DuplicateLevel) =>
  LEVELS.indexOf(level) <= LEVELS.indexOf(min);

const levelOf = (score: number): DuplicateLevel =>
  score >= LEVEL_THRESHOLDS.exact ? 'exact' : score >= LEVEL_THRESHOLDS.likely ? 'likely' : 'possible';

function reasonsText(pairs: DuplicatePair[]): string[] {
  const set = new Set<string>();
  for (const pair of pairs) for (const r of pair.reasons) set.add(`${r.key}: ${r.value}`);
  return [...set];
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

// ---------------------------------------------------------------------------
// Регистрация
// ---------------------------------------------------------------------------

const groupRecordShape = z.object({
  id: z.string(),
  name: z.string().nullable(),
  emails: z.array(z.string()),
  phones: z.array(z.string()),
  inn: z.string().nullable(),
  website: z.string().nullable(),
  created_on: z.string().nullable(),
  related_count: z.number().int().nullable(),
});

export function registerDedupTools(server: McpServer, services: ServiceContainer): void {
  registerFindDuplicates(server, services);
  registerCheckDuplicates(server, services);
  registerMergeDuplicates(server, services);
}

function registerFindDuplicates(server: McpServer, services: ServiceContainer): void {
  const meta = getTool('bpm_find_duplicates');
  server.registerTool(
    meta.name,
    {
      title: meta.title,
      description: meta.description,
      inputSchema: {
        collection: z
          .string()
          .describe('Коллекция: Contact, Account, Lead или любая другая (имя или название)'),
        criteria: z
          .array(criterionSchema)
          .optional()
          .describe('Ограничить область поиска, как в bpm_search_records'),
        join: z.enum(['and', 'or']).optional().describe('Как соединять criteria'),
        filter: z.string().optional().describe('OData $filter (объединяется с criteria через and)'),
        min_level: z
          .enum(LEVELS)
          .optional()
          .describe(
            'Минимальный уровень: exact — почти наверняка, likely — вероятно (по умолчанию), possible — стоит проверить'
          ),
        max_records: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            `Сколько записей просмотреть (по умолчанию ${DEFAULT_MAX_RECORDS}, потолок ${MAX_RECORDS_CAP})`
          ),
        max_groups: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe('Сколько групп вернуть (по умолчанию 50)'),
        related_counts: z
          .boolean()
          .optional()
          .describe(
            `Считать связанные записи у дублей для выбора основной (по умолчанию true, до ${RELATED_COUNT_CAP} записей)`
          ),
      },
      outputSchema: {
        collection: z.string(),
        kind: z.string(),
        compared_by: z.array(z.string()),
        scanned: z.number().int(),
        truncated: z.boolean(),
        counts: z.object({ exact: z.number().int(), likely: z.number().int(), possible: z.number().int() }),
        groups: z.array(
          z.object({
            level: z.enum(LEVELS),
            score: z.number(),
            master_id: z.string(),
            reasons: z.array(z.string()),
            conflicts: z.array(z.string()),
            records: z.array(groupRecordShape),
          })
        ),
        notes: z.array(z.string()),
      },
      annotations: meta.annotations,
    },
    async (params): Promise<CallToolResult> => {
      if (!services.initialized) return notInitialized();
      try {
        await services.authManager.ensureAuthenticated();
        const collection = await resolveCollectionName(services, params.collection);
        const profile = await loadProfile(services, collection);
        const notes: string[] = [];
        const maxRecords = Math.min(params.max_records ?? DEFAULT_MAX_RECORDS, MAX_RECORDS_CAP);
        const minLevel = params.min_level ?? 'likely';

        const compiled = params.criteria?.length
          ? await compileCriteria(services, collection, params.criteria as Criterion[], params.join)
          : undefined;
        const filter = combineFilters(params.filter, compiled?.filter);

        const { rows, truncated } = await pageAll(
          services,
          collection,
          { $filter: filter, $select: profileColumns(profile).join(',') },
          maxRecords
        );
        if (truncated) {
          notes.push(
            `Просмотрено ${rows.length} записей — достигнут max_records, часть дублей может быть не найдена.`
          );
        }

        let comms = new Map<string, string[]>();
        try {
          comms = await loadCommunications(services, profile, new Set(rows.map((r) => String(r.Id))));
        } catch (error) {
          notes.push(`Средства связи не загружены: ${errorText(error)}`);
        }

        const records = rows.map((row) => toDedupRecord(row, profile, comms.get(String(row.Id)) ?? []));
        const byId = new Map(records.map((r) => [r.id, r]));
        const pairs = findDuplicatePairs(records, { threshold: LEVEL_THRESHOLDS.possible });
        const clusters = clusterPairs(pairs, LEVEL_THRESHOLDS.possible);
        const counts = { exact: 0, likely: 0, possible: 0 };
        for (const c of clusters) counts[c.level] += 1;
        const selected = clusters
          .filter((c) => levelAtLeast(c.level, minLevel))
          .slice(0, params.max_groups ?? 50);

        // Число связанных записей — главный критерий выбора основной записи, но стоит запросов.
        const relatedCounts = new Map<string, number>();
        const idsToCount = selected.flatMap((c) => c.ids).slice(0, RELATED_COUNT_CAP);
        if ((params.related_counts ?? true) && idsToCount.length > 0) {
          if (selected.flatMap((c) => c.ids).length > RELATED_COUNT_CAP) {
            notes.push(`Связанные записи посчитаны только для первых ${RELATED_COUNT_CAP} записей из групп.`);
          }
          const { sources } = await referenceSources(services, collection, true);
          const { counts: refCounts } = await countReferences(services, sources, idsToCount);
          for (const id of idsToCount) relatedCounts.set(id, 0);
          for (const r of refCounts) relatedCounts.set(r.id, (relatedCounts.get(r.id) ?? 0) + r.count);
        }

        const groups = selected.map((cluster) => ({
          level: cluster.level,
          score: Math.round(cluster.score * 1000) / 1000,
          master_id: suggestMaster(cluster, byId, relatedCounts),
          reasons: reasonsText(cluster.pairs),
          conflicts: [...new Set(cluster.pairs.flatMap((p) => p.conflicts))],
          records: cluster.ids.map((id) => {
            const r = byId.get(id) as DedupRecord;
            return {
              id,
              name: r.name ?? null,
              emails: r.emails,
              phones: r.phones,
              inn: r.inn ?? null,
              website: r.website ?? null,
              created_on: r.createdOn ?? null,
              related_count: relatedCounts.has(id) ? (relatedCounts.get(id) as number) : null,
            };
          }),
        }));

        const comparedBy = [
          profile.nameField && `название (${profile.nameField})`,
          profile.emailFields.length > 0 && `email (${profile.emailFields.join(', ')})`,
          profile.phoneFields.length > 0 && `телефоны (${profile.phoneFields.join(', ')})`,
          profile.innField && `ИНН (${profile.innField})`,
          profile.websiteField && `сайт (${profile.websiteField})`,
          profile.communication && `средства связи (${profile.communication.collection})`,
        ].filter((x): x is string => typeof x === 'string');

        const lines = [
          `Дубли в ${collection}: просмотрено ${rows.length}; групп exact ${counts.exact}, likely ${counts.likely}, possible ${counts.possible}.`,
          `Сравнение: ${comparedBy.join('; ')}.`,
          '',
          ...groups.flatMap((g, i) => [
            `${i + 1}. [${g.level} ${g.score}] ${g.reasons.join('; ')}` +
              (g.conflicts.length ? ` — конфликты: ${g.conflicts.join('; ')}` : ''),
            ...g.records.map(
              (r) =>
                `   ${r.id === g.master_id ? '*' : '-'} ${r.name ?? '(без названия)'} — ${r.id}` +
                (r.related_count !== null ? `, связанных: ${r.related_count}` : '')
            ),
          ]),
          ...(groups.length === 0 ? [`Групп уровня ${minLevel} и выше не найдено.`] : []),
          ...(notes.length ? ['', ...notes] : []),
          ...(groups.length
            ? ['', '* — предложенная основная запись. Слияние: bpm_merge_duplicates (сначала без confirm).']
            : []),
        ];

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: {
            collection,
            kind: profile.kind,
            compared_by: comparedBy,
            scanned: rows.length,
            truncated,
            counts,
            groups,
            notes,
          },
        };
      } catch (error) {
        const toolError = formatToolError(error, params.collection);
        return { content: [{ type: 'text', text: JSON.stringify(toolError, null, 2) }], isError: true };
      }
    }
  );
}

function registerCheckDuplicates(server: McpServer, services: ServiceContainer): void {
  const meta = getTool('bpm_check_duplicates');
  server.registerTool(
    meta.name,
    {
      title: meta.title,
      description: meta.description,
      inputSchema: {
        collection: z.string().describe('Коллекция: Contact, Account, Lead и т. п.'),
        data: z
          .record(z.string(), z.unknown())
          .describe('Данные будущей записи, как в bpm_create_record: имена полей или русские подписи'),
        min_level: z
          .enum(LEVELS)
          .optional()
          .describe('Минимальный уровень совпадения (по умолчанию possible)'),
        limit: z
          .number()
          .int()
          .positive()
          .max(50)
          .optional()
          .describe('Сколько совпадений вернуть (по умолчанию 10)'),
      },
      outputSchema: {
        collection: z.string(),
        has_duplicates: z.boolean(),
        matches: z.array(
          z.object({
            id: z.string(),
            name: z.string().nullable(),
            score: z.number(),
            level: z.enum(LEVELS),
            reasons: z.array(z.string()),
            conflicts: z.array(z.string()),
          })
        ),
        searched_by: z.array(z.string()),
      },
      annotations: meta.annotations,
    },
    async (params): Promise<CallToolResult> => {
      if (!services.initialized) return notInitialized();
      try {
        await services.authManager.ensureAuthenticated();
        const collection = await resolveCollectionName(services, params.collection);
        const profile = await loadProfile(services, collection);
        const version = services.config.odata_version;

        // Ключи data → имена колонок (подписи тоже); неизвестные строки — как доп. средства связи.
        const row: Record<string, unknown> = { Id: '' };
        const extras: string[] = [];
        for (const [key, value] of Object.entries(params.data)) {
          const ref = await services.metadataManager.resolveFieldReference(collection, key);
          if (ref.name) row[ref.name] = value;
          else if (typeof value === 'string') extras.push(value);
        }
        const candidate = toDedupRecord(row, profile, extras);

        // Кандидаты — узким запросом по признакам записи, а не полным сканом коллекции.
        const predicates: string[] = [];
        const searchedBy: string[] = [];
        // Фрагменты слов, а не слово целиком: опечатка в начале («Ыванов») не должна прятать «Иванова».
        const nameFragments = candidate.name
          ? [
              ...new Set(
                (candidate.kind === 'organization'
                  ? normalizeOrgName(candidate.name)
                  : normalizePersonName(candidate.name)
                )
                  .split(' ')
                  .filter((t) => t.length >= 4)
                  .sort((a, b) => b.length - a.length)
                  .slice(0, 3)
                  .flatMap((t) => [t.slice(0, 4), t.slice(-4)])
              ),
            ]
          : [];
        if (nameFragments.length && profile.nameField) {
          searchedBy.push(`название содержит «${nameFragments.join('» или «')}»`);
        }
        for (const email of candidate.emails) {
          for (const f of profile.emailFields) predicates.push(`${f} eq '${escapeODataString(email)}'`);
          searchedBy.push(`email ${email}`);
        }
        if (candidate.inn && profile.innField) {
          predicates.push(
            `${profile.innField} eq '${escapeODataString(normalizeInn(candidate.inn) ?? candidate.inn)}'`
          );
          searchedBy.push(`ИНН ${candidate.inn}`);
        }
        const domain = candidate.website ? normalizeDomain(candidate.website) : null;
        if (domain && profile.websiteField) {
          predicates.push(containsExpression(profile.websiteField, domain, version));
          searchedBy.push(`сайт ${domain}`);
        }

        const runQuery = async (caseInsensitive: boolean) => {
          const nameField = profile.nameField;
          const nameExprs = nameField
            ? nameFragments.map((f) => containsExpression(nameField, f, version, { caseInsensitive }))
            : [];
          const parts = [...nameExprs, ...predicates];
          if (parts.length === 0) return [];
          const page = await services.odataClient.getRecords<Record<string, unknown>>(collection, {
            $filter: parts.map((p) => `(${p})`).join(' or '),
            $select: profileColumns(profile).join(','),
            $top: 200,
          });
          return page.value;
        };
        let rows: Array<Record<string, unknown>>;
        if (isTolowerSupported()) {
          try {
            rows = await runQuery(true);
          } catch (error) {
            if (!isQueryUnsupportedError(error)) throw error;
            markTolowerUnsupported();
            rows = await runQuery(false);
          }
        } else {
          rows = await runQuery(false);
        }
        const ids = new Set(rows.map((r) => String(r.Id)));

        // Телефоны и почта из средств связи. SearchNumber — цифры номера задом наперёд.
        if (profile.communication && (candidate.phones.length || candidate.emails.length)) {
          const { collection: commSet, field } = profile.communication;
          const numberPredicates = [
            ...candidate.emails.map((e) => `Number eq '${escapeODataString(e)}'`),
            ...candidate.phones
              .map((p) => normalizePhone(p))
              .filter((p): p is string => Boolean(p))
              .map((p) =>
                containsExpression('SearchNumber', p.slice(-7).split('').reverse().join(''), version)
              ),
          ];
          try {
            const page = await services.odataClient.getRecords<Record<string, unknown>>(commSet, {
              $filter: numberPredicates.map((p) => `(${p})`).join(' or '),
              $select: `Id,Number,${field}`,
              $top: 200,
            });
            const owners = [
              ...new Set(
                page.value.map((r) => String(r[field] ?? '')).filter((o) => !isDefaultValue(o) && !ids.has(o))
              ),
            ];
            if (owners.length) {
              const extra = await services.odataClient.getRecords<Record<string, unknown>>(collection, {
                $filter: owners
                  .slice(0, 50)
                  .map((o) => `Id eq ${guidLiteral(o, version)}`)
                  .join(' or '),
                $select: profileColumns(profile).join(','),
              });
              rows.push(...extra.value);
              for (const r of extra.value) ids.add(String(r.Id));
            }
            searchedBy.push(`средства связи (${commSet})`);
          } catch {
            // Колонки SearchNumber может не быть — остаёмся на основных полях.
          }
        }
        for (const p of candidate.phones) searchedBy.push(`телефон ${p}`);

        const comms = await loadCommunicationsFor(services, profile, [...ids]);
        const existing = rows.map((r) => toDedupRecord(r, profile, comms.get(String(r.Id)) ?? []));
        const byId = new Map(existing.map((r) => [r.id, r]));
        const minLevel = params.min_level ?? 'possible';
        const matches = matchAgainst(candidate, existing, { threshold: LEVEL_THRESHOLDS.possible })
          .map((pair) => {
            const otherId = pair.a === candidate.id ? pair.b : pair.a;
            return {
              id: otherId,
              name: byId.get(otherId)?.name ?? null,
              score: Math.round(pair.score * 1000) / 1000,
              level: levelOf(pair.score),
              reasons: pair.reasons.map((r) => `${r.key}: ${r.value}`),
              conflicts: pair.conflicts,
            };
          })
          .filter((m) => levelAtLeast(m.level, minLevel))
          .sort((a, b) => b.score - a.score)
          .slice(0, params.limit ?? 10);

        const lines = matches.length
          ? [
              `Похоже, такая запись уже есть в ${collection}: ${matches.length}`,
              ...matches.map(
                (m) =>
                  `  - [${m.level} ${m.score}] ${m.name ?? '(без названия)'} — ${m.id}: ${m.reasons.join('; ')}` +
                  (m.conflicts.length ? ` (конфликты: ${m.conflicts.join('; ')})` : '')
              ),
              '',
              'Перед созданием уточните у пользователя; обновить существующую — bpm_update_record.',
            ]
          : [
              `Дублей в ${collection} не найдено. Искали по: ${
                searchedBy.join('; ') || 'нечему — в data нет названия, email, телефона, ИНН или сайта'
              }.`,
            ];

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: {
            collection,
            has_duplicates: matches.length > 0,
            matches,
            searched_by: searchedBy,
          },
        };
      } catch (error) {
        const toolError = formatToolError(error, params.collection);
        return { content: [{ type: 'text', text: JSON.stringify(toolError, null, 2) }], isError: true };
      }
    }
  );
}

function registerMergeDuplicates(server: McpServer, services: ServiceContainer): void {
  const meta = getTool('bpm_merge_duplicates');
  server.registerTool(
    meta.name,
    {
      title: meta.title,
      description: meta.description,
      inputSchema: {
        collection: z.string().describe('Коллекция: Contact, Account, Lead и т. п.'),
        master_id: z.string().describe('Основная запись (UUID или название) — она остаётся'),
        duplicate_ids: z
          .array(z.string())
          .min(1)
          .max(20)
          .describe(
            'Дубли (UUID или названия): их ссылки перейдут на основную запись, сами они будут удалены'
          ),
        fill_empty_fields: z
          .boolean()
          .optional()
          .describe('Заполнить пустые поля основной записи значениями из дублей (по умолчанию true)'),
        keep_duplicates: z
          .boolean()
          .optional()
          .describe('Не удалять дубли после перепривязки (по умолчанию false)'),
        allow_unreadable_sources: z
          .boolean()
          .optional()
          .describe(
            'Удалять дубли, даже если часть таблиц со ссылками на стенде не читается (СУБД сама не даст удалить, если ссылки там есть). По умолчанию false'
          ),
        expected_references: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Число ссылок из плана; при расхождении слияние отменяется'),
        max_references: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Предохранитель: если ссылок больше — отказ (по умолчанию 1000)'),
        confirm: confirmParam,
      },
      outputSchema: {
        code: z.string().optional(),
        requires_confirmation: z.boolean().optional(),
        collection: z.string(),
        master_id: z.string(),
        duplicate_ids: z.array(z.string()),
        fill_fields: z.record(z.string(), z.unknown()),
        references: z.array(
          z.object({
            collection: z.string(),
            field: z.string(),
            duplicate_id: z.string(),
            count: z.number().int(),
          })
        ),
        expected_references: z.number().int(),
        count_failures: z.array(z.string()),
        not_repointed: z.array(z.string()),
        result: z
          .object({
            filled: z.array(z.string()),
            repointed: z.number().int(),
            failed: z.array(z.object({ collection: z.string(), id: z.string(), error: z.string() })),
            deleted: z.array(z.string()),
            kept: z.array(z.string()),
            snapshots: z.array(z.record(z.string(), z.unknown())),
          })
          .optional(),
      },
      annotations: meta.annotations,
    },
    async (params): Promise<CallToolResult> => {
      if (!services.initialized) return notInitialized();
      try {
        await services.authManager.ensureAuthenticated();
        const collection = await resolveCollectionName(services, params.collection);
        const version = services.config.odata_version;
        const master = await resolveRecordId(services, collection, params.master_id);
        const duplicateIds: string[] = [];
        for (const raw of params.duplicate_ids) {
          const { id } = await resolveRecordId(services, collection, raw);
          if (id === master.id) throw new Error('Основная запись не может быть в списке дублей.');
          if (!duplicateIds.includes(id)) duplicateIds.push(id);
        }

        const entityMeta = await services.metadataManager.getEntityMetadata(collection);
        const masterRecord = await services.odataClient.getRecord<Record<string, unknown>>(
          collection,
          master.id
        );
        const duplicates = await Promise.all(
          duplicateIds.map((id) => services.odataClient.getRecord<Record<string, unknown>>(collection, id))
        );
        const fillFields =
          params.fill_empty_fields === false ? {} : planFillFields(entityMeta, masterRecord, duplicates);

        const { sources, skipped } = await referenceSources(services, collection, false);
        const { counts, failed: countFailures } = await countReferences(services, sources, duplicateIds);
        const references = counts.map((c) => ({
          collection: c.source.collection,
          field: c.source.field,
          duplicate_id: c.id,
          count: c.count,
        }));
        const total = references.reduce((sum, r) => sum + r.count, 0);
        const maxReferences = params.max_references ?? 1000;

        const plan = {
          collection,
          master_id: master.id,
          duplicate_ids: duplicateIds,
          fill_fields: fillFields,
          references,
          expected_references: total,
          count_failures: countFailures,
          not_repointed: skipped,
        };
        const planLines = [
          `План слияния ${collection}: основная ${master.id}${master.matched ? ` («${master.matched}»)` : ''}; дубли: ${duplicateIds.join(', ')}`,
          `Заполнить пустые поля основной: ${
            Object.keys(fillFields).length
              ? Object.entries(fillFields)
                  .map(([k, v]) => `${k}=${String(v)}`)
                  .join('; ')
              : 'нечего'
          }`,
          `Перепривязать ссылок: ${total}`,
          ...references.map((r) => `  - ${r.collection}.${r.field} (дубль ${r.duplicate_id}): ${r.count}`),
          ...(countFailures.length
            ? [
                `Не читаются таблицы со ссылками: ${countFailures.length} (${countFailures.slice(0, 5).join('; ')}).`,
                params.allow_unreadable_sources
                  ? 'Дубли всё равно будут удалены (allow_unreadable_sources=true); если ссылки там есть, СУБД удаление отклонит.'
                  : 'Без allow_unreadable_sources=true дубли после перепривязки останутся.',
              ]
            : []),
          ...(skipped.length
            ? [`Системные ссылки и представления не перепривязываются: ${skipped.length}`]
            : []),
          params.keep_duplicates ? 'Дубли останутся.' : 'После перепривязки дубли будут удалены.',
        ];

        if (total > maxReferences) {
          return {
            content: [
              {
                type: 'text',
                text: [
                  ...planLines,
                  '',
                  `Ссылок больше max_references=${maxReferences} — слияние не выполняется.`,
                ].join('\n'),
              },
            ],
            structuredContent: { ...plan, code: 'too_many_references' },
            isError: true,
          };
        }

        if (confirmationRequired(params)) {
          return {
            content: [
              {
                type: 'text',
                text: [
                  ...planLines,
                  '',
                  `Ничего не изменено. Для выполнения повторите с confirm=true и expected_references=${total}.`,
                ].join('\n'),
              },
            ],
            structuredContent: { ...plan, code: 'confirm_required', requires_confirmation: true },
          };
        }
        if (params.expected_references !== total) {
          return {
            content: [
              {
                type: 'text',
                text: `Ссылок сейчас ${total}, ожидалось ${params.expected_references ?? 'не указано'}. Слияние отменено: запросите план заново.`,
              },
            ],
            structuredContent: { ...plan, code: 'expected_count_mismatch' },
            isError: true,
          };
        }

        // 1. Поля основной записи.
        const filled = Object.keys(fillFields);
        if (filled.length) await services.odataClient.updateRecord(collection, master.id, fillFields);

        // 2. Перепривязка: Id ссылающихся записей, затем PATCH каждой.
        const failed: Array<{ collection: string; id: string; error: string }> = [];
        let repointed = 0;
        const sourceByKey = new Map(sources.map((s) => [`${s.collection}.${s.field}`, s]));
        for (const ref of references) {
          const source = sourceByKey.get(`${ref.collection}.${ref.field}`) as ReferenceSource;
          const { rows } = await pageAll(
            services,
            ref.collection,
            { $filter: referenceFilter(source, ref.duplicate_id, version), $select: 'Id' },
            maxReferences
          );
          await mapLimit(rows, 5, async (row) => {
            try {
              await services.odataClient.updateRecord(ref.collection, String(row.Id), {
                [ref.field]: master.id,
              });
              repointed += 1;
            } catch (error) {
              failed.push({ collection: ref.collection, id: String(row.Id), error: errorText(error) });
            }
          });
        }

        // 3. Удаление дублей — только если всё перепривязано и все ссылки были посчитаны.
        const deleted: string[] = [];
        const kept: string[] = [];
        const snapshots: Array<Record<string, unknown>> = [];
        const safeToDelete =
          !params.keep_duplicates &&
          failed.length === 0 &&
          (countFailures.length === 0 || params.allow_unreadable_sources === true);
        for (const [index, id] of duplicateIds.entries()) {
          if (!safeToDelete) {
            kept.push(id);
            continue;
          }
          try {
            await services.odataClient.deleteRecord(collection, id);
            deleted.push(id);
            snapshots.push(duplicates[index]);
          } catch (error) {
            kept.push(id);
            failed.push({ collection, id, error: `удаление: ${errorText(error)}` });
          }
        }

        const lines = [
          `Слияние ${collection} → ${master.id}: заполнено полей ${filled.length}, перепривязано ${repointed} из ${total}, удалено дублей ${deleted.length}.`,
          ...(kept.length
            ? [
                `Оставлены: ${kept.join(', ')}` +
                  (params.keep_duplicates
                    ? '.'
                    : ' — были ошибки перепривязки, подсчёта или удаления; дубли не тронуты ради сохранности данных.'),
              ]
            : []),
          ...failed.slice(0, 20).map((f) => `  ! ${f.collection}(${f.id}): ${f.error}`),
          ...(snapshots.length
            ? ['', 'Снимки удалённых записей — в structuredContent.result.snapshots.']
            : []),
        ];

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: { ...plan, result: { filled, repointed, failed, deleted, kept, snapshots } },
          isError: total > 0 && repointed === 0,
        };
      } catch (error) {
        const toolError = formatToolError(error, params.collection);
        return { content: [{ type: 'text', text: JSON.stringify(toolError, null, 2) }], isError: true };
      }
    }
  );
}
