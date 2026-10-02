import { duplicateFieldsOutputShape, findDuplicatesByFields } from './analytics-tools.js';
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
import { BpmApiError, formatToolError, isQueryUnsupportedError } from '../utils/errors.js';
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
import {
  confirmParam,
  confirmationTokenParam,
  confirmationResponse,
  createConfirmationPlan,
  consumeConfirmationPlan,
  operationFingerprint,
} from '../utils/confirm.js';
import {
  recordId,
  recordEtag,
  previewRecordSummary,
  concurrencyProtection,
  writeFailureState,
  writeToolError,
} from '../utils/write-safety.js';
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

/** OData transport annotations differ between collection rows and entity responses. Keep the record version. */
function mergeSnapshot(record: Record<string, unknown>): Record<string, unknown> {
  const snapshot = Object.fromEntries(
    Object.entries(record).filter(
      ([key]) => key !== '__metadata' && (!key.includes('@odata.') || key === '@odata.etag')
    )
  );
  const etag = recordEtag(record);
  if (etag !== undefined) snapshot['@odata.etag'] = etag;
  return snapshot;
}

interface MergeReference {
  source: ReferenceSource;
  duplicateId: string;
  record: Record<string, unknown>;
  writable: boolean;
}
interface MergeOutcome {
  step: 'fill' | 'repoint' | 'delete';
  collection: string;
  id: string;
  fields?: string[];
  state: 'succeeded' | 'failed' | 'not_executed' | 'outcome_unknown';
  error?: string;
}

/** Read-only discovery may run concurrently; mutations use the confirmed snapshots sequentially. */
async function collectMergeReferences(
  services: ServiceContainer,
  collection: string,
  duplicateIds: string[],
  maxReferences: number
): Promise<{ rows: MergeReference[]; failed: string[]; skipped: string[] }> {
  const { sources, skipped } = await referenceSources(services, collection, false);
  const skippedKeys = new Set(skipped);
  const graph = await services.metadataManager.getLookupGraph();
  const blocked = (graph.incoming.get(collection) ?? [])
    .filter((edge) => skippedKeys.has(`${edge.from}.${edge.field}`))
    .map((edge) => ({ collection: edge.from, field: edge.field, nav: edge.nav }));
  const jobs = [
    ...sources.map((source) => ({ source, writable: true })),
    ...blocked.map((source) => ({ source, writable: false })),
  ]
    .flatMap((job) => duplicateIds.map((duplicateId) => ({ ...job, duplicateId })))
    .sort((a, b) =>
      `${a.source.collection}.${a.source.field}.${a.duplicateId}`.localeCompare(
        `${b.source.collection}.${b.source.field}.${b.duplicateId}`
      )
    );
  const pages = await mapLimit(jobs, 8, async (job) => {
    const label = `${job.source.collection}.${job.source.field}`;
    try {
      const query = {
        $filter: referenceFilter(job.source, job.duplicateId, services.config.odata_version),
        $orderby: 'Id',
        $top: maxReferences + 1,
      };
      const read = (count: boolean) =>
        services.odataClient.getRecords<Record<string, unknown>>(
          job.source.collection,
          { ...query, ...(count ? { $count: true } : {}) },
          true,
          maxReferences + 1
        );
      // Some BPMSoft sources support paginated reads but reject inline count. Both attempts are reads.
      const page = await read(true).catch(() => read(false));
      const ids = page.value.map(recordId);
      if (
        page.value.length > maxReferences ||
        page['@odata.nextLink'] ||
        (page as unknown as { __next?: string }).__next ||
        (page['@odata.count'] !== undefined && page['@odata.count'] !== page.value.length) ||
        new Set(ids.map((id) => id.toLowerCase())).size !== ids.length
      ) {
        throw new BpmApiError(
          `Нельзя доказать полный состав ссылок ${label}; уточните предел или доступ.`,
          400,
          collection,
          undefined,
          undefined,
          undefined,
          'validation'
        );
      }
      for (const record of page.value) {
        if (
          typeof record[job.source.field] !== 'string' ||
          String(record[job.source.field]).toLowerCase() !== job.duplicateId.toLowerCase()
        ) {
          throw new BpmApiError(
            `Ссылка ${label} не соответствует выбранному дублю.`,
            409,
            collection,
            undefined,
            undefined,
            undefined,
            'validation'
          );
        }
      }
      return {
        rows: page.value
          .sort((a, b) => recordId(a).localeCompare(recordId(b)))
          .map((record) => ({ ...job, record })),
        failed: [] as string[],
      };
    } catch (error) {
      return { rows: [] as MergeReference[], failed: [`${label}: ${errorText(error)}`] };
    }
  });
  return {
    rows: pages.flatMap((page) => page.rows),
    failed: [...new Set(pages.flatMap((page) => page.failed))],
    skipped,
  };
}

function groupedMergeWrites(
  references: MergeReference[]
): Array<{ collection: string; id: string; record: Record<string, unknown>; fields: string[] }> {
  const grouped = new Map<
    string,
    { collection: string; id: string; record: Record<string, unknown>; fields: string[] }
  >();
  for (const reference of references.filter((reference) => reference.writable)) {
    const id = recordId(reference.record);
    const key = `${reference.source.collection}:${id.toLowerCase()}`;
    const existing = grouped.get(key);
    if (existing) {
      if (
        operationFingerprint(mergeSnapshot(existing.record)) !==
        operationFingerprint(mergeSnapshot(reference.record))
      )
        throw new BpmApiError(
          'Связанная запись изменилась во время построения плана. Получите план заново.',
          409,
          reference.source.collection
        );
      if (!existing.fields.includes(reference.source.field)) existing.fields.push(reference.source.field);
    } else
      grouped.set(key, {
        collection: reference.source.collection,
        id,
        record: reference.record,
        fields: [reference.source.field],
      });
  }
  return [...grouped.values()]
    .map((write) => ({ ...write, fields: write.fields.sort() }))
    .sort((a, b) => `${a.collection}:${a.id}`.localeCompare(`${b.collection}:${b.id}`));
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
        fields: z
          .array(z.string().min(1).max(256))
          .min(1)
          .max(8)
          .optional()
          .describe(
            'Явные поля совместного нормализованного ключа. Без fields — профильный анализ email, телефонов, ИНН и названия.'
          ),
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
        success: z.boolean().optional(),
        fields: z.array(z.string()).optional(),
        complete: z.boolean().optional(),
        scanned_count: z.number().int().optional(),
        total_count: z.number().int().optional(),
        has_more: z.boolean().optional(),
        truncated_groups: z.boolean().optional(),
        observed_group_count: z.number().int().optional(),
        observed_duplicate_records: z.number().int().optional(),
        warnings: z.array(z.string()).optional(),
        field_labels: z.record(z.string(), z.string()).optional(),
        kind: z.string().optional(),
        compared_by: z.array(z.string()).optional(),
        scanned: z.number().int().optional(),
        truncated: z.boolean().optional(),
        counts: z
          .object({ exact: z.number().int(), likely: z.number().int(), possible: z.number().int() })
          .optional(),
        groups: z.union([
          duplicateFieldsOutputShape.groups,
          z.array(
            z.object({
              level: z.enum(LEVELS),
              score: z.number(),
              master_id: z.string(),
              reasons: z.array(z.string()),
              conflicts: z.array(z.string()),
              records: z.array(groupRecordShape),
            })
          ),
        ]),
        notes: z.array(z.string()).optional(),
      },
      annotations: meta.annotations,
    },
    async (params): Promise<CallToolResult> => {
      if (params.fields) {
        if (params.filter || params.min_level || params.related_counts !== undefined)
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: 'fields задаёт точный ключ; filter, min_level и related_counts относятся к профильному анализу. Для ключа передайте criteria.',
              },
            ],
          };
        return findDuplicatesByFields(services, params);
      }
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
            'Совместимый параметр. Неполный обзор ссылок больше не разрешает удаление; keep_duplicates=true позволяет перепривязать проверенные читаемые ссылки.'
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
          .max(MAX_RECORDS_CAP)
          .optional()
          .describe('Предохранитель: если ссылок больше — отказ (по умолчанию 1000)'),
        confirm: confirmParam,
        confirmation_token: confirmationTokenParam,
      },
      outputSchema: {
        confirmation_token: z.string().optional(),
        concurrency_protection: z.enum(['etag', 'snapshot_only']).optional(),
        records: z.array(z.object({ id: z.string(), display_value: z.string() })).optional(),
        reference_records: z
          .array(z.object({ collection: z.string(), id: z.string(), fields: z.array(z.string()) }))
          .optional(),
        outcomes: z
          .array(
            z.object({
              step: z.enum(['fill', 'repoint', 'delete']),
              collection: z.string(),
              id: z.string(),
              fields: z.array(z.string()).optional(),
              state: z.enum(['succeeded', 'failed', 'not_executed', 'outcome_unknown']),
              error: z.string().optional(),
            })
          )
          .optional(),
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
      let mergeOutcomes: MergeOutcome[] = [];
      try {
        await services.authManager.ensureAuthenticated();
        const collection = await resolveCollectionName(services, params.collection);
        const master = await resolveRecordId(services, collection, params.master_id, { fuzzy: false });
        const duplicateIds: string[] = [];
        for (const raw of params.duplicate_ids) {
          const { id } = await resolveRecordId(services, collection, raw, { fuzzy: false });
          if (id.toLowerCase() === master.id.toLowerCase())
            throw new Error('Основная запись не может быть в списке дублей.');
          if (!duplicateIds.some((existing) => existing.toLowerCase() === id.toLowerCase()))
            duplicateIds.push(id);
        }

        if (!duplicateIds.length || duplicateIds.length > 20)
          throw new BpmApiError('Передайте от 1 до 20 UUID дублей.', 400, collection);
        duplicateIds.sort();
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

        const maxReferences = params.max_references ?? 1000;
        if (!Number.isInteger(maxReferences) || maxReferences < 1 || maxReferences > MAX_RECORDS_CAP)
          throw new BpmApiError(`max_references должен быть от 1 до ${MAX_RECORDS_CAP}.`, 400, collection);
        if (
          recordId(masterRecord).toLowerCase() !== master.id.toLowerCase() ||
          duplicates.some(
            (record, index) => recordId(record).toLowerCase() !== duplicateIds[index].toLowerCase()
          )
        )
          throw new BpmApiError('Ответ сервера не соответствует выбранным UUID.', 409, collection);
        const selection = await collectMergeReferences(services, collection, duplicateIds, maxReferences);
        const countFailures = selection.failed;
        const skipped = selection.skipped;
        const blocked = selection.rows.filter((reference) => !reference.writable);
        const writable = selection.rows.filter((reference) => reference.writable);
        const writes = groupedMergeWrites(writable);
        const referenceCounts = new Map<
          string,
          { collection: string; field: string; duplicate_id: string; count: number }
        >();
        for (const reference of writable) {
          const key = `${reference.source.collection}.${reference.source.field}.${reference.duplicateId}`;
          const existing = referenceCounts.get(key);
          if (existing) existing.count += 1;
          else
            referenceCounts.set(key, {
              collection: reference.source.collection,
              field: reference.source.field,
              duplicate_id: reference.duplicateId,
              count: 1,
            });
        }
        const references = [...referenceCounts.values()];
        const total = writable.length;

        const plan = {
          collection,
          master_id: master.id,
          duplicate_ids: duplicateIds,
          fill_fields: fillFields,
          references,
          expected_references: total,
          count_failures: countFailures,
          not_repointed: skipped,
          records: previewRecordSummary([masterRecord, ...duplicates]),
          concurrency_protection: concurrencyProtection([
            masterRecord,
            ...duplicates,
            ...selection.rows.map((reference) => reference.record),
          ]),
          reference_records: writes.map(({ collection, id, fields }) => ({ collection, id, fields })),
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
                `Неполный или недоступный обзор источников ссылок: ${countFailures.length} (${countFailures.slice(0, 5).join('; ')}).`,
                'Удаление при неполном обзоре запрещено. keep_duplicates=true позволяет выполнить только проверенные перепривязки.',
              ]
            : []),
          ...(skipped.length
            ? [`Системные ссылки и представления не перепривязываются: ${skipped.length}`]
            : []),
          ...(blocked.length
            ? [`Непереносимых системных ссылок: ${blocked.length}; удаление дублей запрещено.`]
            : []),
          params.keep_duplicates
            ? 'Дубли останутся.'
            : 'После перепривязки и контрольного чтения дубли будут удалены.',
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

        if (!params.keep_duplicates && (countFailures.length || blocked.length)) {
          return {
            content: [
              {
                type: 'text',
                text: [
                  ...planLines,
                  'Слияние с удалением не подготовлено: полный безопасный обзор ссылок отсутствует. Можно получить отдельный план с keep_duplicates=true.',
                ].join('\n'),
              },
            ],
            structuredContent: { ...plan, code: 'reference_selection_incomplete' },
            isError: true,
          };
        }
        const operation = {
          tool: meta.name,
          collection,
          input_master: params.master_id,
          input_duplicates: params.duplicate_ids,
          master: mergeSnapshot(masterRecord),
          duplicates: duplicates.map(mergeSnapshot),
          fill_fields: fillFields,
          reference_snapshots: selection.rows.map((reference) => ({
            ...reference,
            record: mergeSnapshot(reference.record),
          })),
          failed_sources: countFailures,
          skipped,
          fill_empty_fields: params.fill_empty_fields !== false,
          keep_duplicates: params.keep_duplicates === true,
          allow_unreadable_sources: params.allow_unreadable_sources === true,
          max_references: maxReferences,
          expected_references: total,
        };
        if (params.confirm !== true)
          return confirmationResponse(meta.name, planLines, {
            ...plan,
            confirmation_token: createConfirmationPlan(services, operation),
          });
        if (params.expected_references !== total)
          return {
            content: [
              {
                type: 'text',
                text: `Ссылок сейчас ${total}, ожидалось ${params.expected_references ?? 'не указано'}. Получите новый план.`,
              },
            ],
            structuredContent: { ...plan, code: 'expected_count_mismatch' },
            isError: true,
          };
        consumeConfirmationPlan(services, params.confirmation_token, operation);

        const filled: string[] = [];
        const failed: Array<{ collection: string; id: string; error: string }> = [];
        const deleted: string[] = [];
        const snapshots: Record<string, unknown>[] = [];
        let repointed = 0;
        let stopped = false;
        const mutations: Array<{
          outcome: MergeOutcome;
          record: Record<string, unknown>;
          data?: Record<string, unknown>;
        }> = [];
        if (Object.keys(fillFields).length)
          mutations.push({
            outcome: {
              step: 'fill',
              collection,
              id: master.id,
              fields: Object.keys(fillFields),
              state: 'not_executed',
            },
            record: masterRecord,
            data: fillFields,
          });
        for (const write of writes)
          mutations.push({
            outcome: {
              step: 'repoint',
              collection: write.collection,
              id: write.id,
              fields: write.fields,
              state: 'not_executed',
            },
            record: write.record,
            data: Object.fromEntries(write.fields.map((field) => [field, master.id])),
          });
        if (!params.keep_duplicates)
          duplicateIds.forEach((id, index) =>
            mutations.push({
              outcome: { step: 'delete', collection, id, state: 'not_executed' },
              record: duplicates[index],
            })
          );
        mergeOutcomes = mutations.map((mutation) => mutation.outcome);
        for (const mutation of mutations) {
          if (stopped) break;
          const outcome = mutation.outcome;
          if (outcome.step === 'delete') {
            // A reference may have been added since confirmation. Do not delete on incomplete or nonempty readback.
            const remaining = await collectMergeReferences(services, collection, [outcome.id], maxReferences);
            if (
              remaining.failed.length ||
              remaining.rows.length ||
              remaining.skipped.slice().sort().join('\n') !== skipped.slice().sort().join('\n')
            ) {
              const message =
                'Контрольное чтение обнаружило оставшиеся/новые ссылки или неполный обзор. Дубли не удалены; проверьте результаты и получите новый план.';
              failed.push({ collection, id: outcome.id, error: message });
              stopped = true;
              break;
            }
            // Deletion is allowed only while every duplicate still matches the confirmed snapshot.
            try {
              const current = await services.odataClient.getRecord<Record<string, unknown>>(
                collection,
                outcome.id
              );
              if (
                operationFingerprint(mergeSnapshot(current)) !==
                operationFingerprint(mergeSnapshot(mutation.record))
              )
                throw new BpmApiError(
                  'Дубли изменились во время слияния. Удаление отменено.',
                  409,
                  collection
                );
            } catch (error) {
              failed.push({ collection, id: outcome.id, error: errorText(error) });
              stopped = true;
              break;
            }
          }
          try {
            if (recordEtag(mutation.record) === undefined) {
              const current = await services.odataClient.getRecord<Record<string, unknown>>(
                outcome.collection,
                outcome.id
              );
              if (
                operationFingerprint(mergeSnapshot(current)) !==
                operationFingerprint(mergeSnapshot(mutation.record))
              )
                throw new BpmApiError(
                  'Запись изменилась перед выполнением шага слияния.',
                  409,
                  outcome.collection
                );
            }
            if (outcome.step === 'delete') {
              await services.odataClient.deleteRecord(outcome.collection, outcome.id, {
                expectedEtag: recordEtag(mutation.record),
              });
              deleted.push(outcome.id);
              snapshots.push(mutation.record);
            } else {
              await services.odataClient.updateRecord(outcome.collection, outcome.id, mutation.data!, {
                expectedEtag: recordEtag(mutation.record),
              });
              if (outcome.step === 'fill') filled.push(...(outcome.fields ?? []));
              else repointed += (outcome.fields ?? []).length;
            }
            outcome.state = 'succeeded';
          } catch (error) {
            outcome.state = writeFailureState(error);
            outcome.error = errorText(error);
            failed.push({ collection: outcome.collection, id: outcome.id, error: outcome.error });
            stopped = true;
          }
        }
        const kept = duplicateIds.filter((id) => !deleted.includes(id));
        const lines = [
          `Слияние ${collection} → ${master.id}: заполнено полей ${filled.length}, перепривязано ${repointed} из ${total}, удалено дублей ${deleted.length}.`,
          ...(kept.length
            ? [
                `Оставлены: ${kept.join(', ')}${params.keep_duplicates ? ' (keep_duplicates=true).' : '; удаление не завершено — проверьте outcomes перед новым планом.'}`,
              ]
            : []),
          ...(countFailures.length
            ? [
                `Обзор ссылок остаётся неполным: ${countFailures.length} (${countFailures.slice(0, 5).join('; ')}).`,
                'Выполнение ограничено проверенными ссылками; дубли сохранены. Непроверенные источники перечислены в count_failures.',
              ]
            : []),
          ...(mergeOutcomes.some((outcome) => outcome.state === 'outcome_unknown')
            ? [
                'Исход одной операции неопределён. Зависимые изменения остановлены; сначала прочитайте соответствующую запись по UUID.',
              ]
            : []),
          ...failed
            .slice(0, 20)
            .map((failure) => `  ! ${failure.collection}(${failure.id}): ${failure.error}`),
          ...(snapshots.length ? ['Снимки удалённых записей — в structuredContent.result.snapshots.'] : []),
        ];
        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: {
            ...plan,
            outcomes: mergeOutcomes,
            result: { filled, repointed, failed, deleted, kept, snapshots },
          },
          isError: failed.length > 0 || mergeOutcomes.some((outcome) => outcome.state !== 'succeeded'),
        };
      } catch (error) {
        const toolError = {
          ...writeToolError(error, params.collection),
          ...(mergeOutcomes.length ? { outcomes: mergeOutcomes } : {}),
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(toolError, null, 2) }],
          structuredContent: toolError,
          isError: true,
        };
      }
    }
  );
}
