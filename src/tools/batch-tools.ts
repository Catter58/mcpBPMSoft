/**
 * MCP Tools: Batch operations
 *
 * Модель передаёт массив; как его отправить ($batch или по одному) решает
 * ODataClient.executeBulk. Имена записей, lookup-поля и поиск уже существующих
 * записей сервер разрешает сам, ошибки — поштучно по индексу.
 *
 * bpm_batch_create — create multiple records in one $batch
 * bpm_batch_update — update multiple records in one $batch
 * bpm_batch_delete — delete multiple records in one $batch
 */

import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceContainer } from './init-tool.js';
import { BpmApiError, parseODataError, UnknownFieldError } from '../utils/errors.js';
import { getTool } from './registry.js';
import {
  notInitialized,
  lookupNotesText,
  lookupNotesStructured,
  resolveCollectionName,
  resolveRecordId,
} from './_guards.js';
import { coercedText, type CoercedValueNote } from '../utils/coerce.js';
import type { ResolvedLookupNote } from '../lookup/lookup-resolver.js';
import {
  confirmParam,
  confirmationTokenParam,
  confirmationResponse,
  createConfirmationPlan,
  consumeConfirmationPlan,
  operationFingerprint,
} from '../utils/confirm.js';
import {
  creationRecordId,
  recordId,
  recordEtag,
  validateIdempotencyKey,
  validateRequiredCreateFields,
  writeToolError,
  writeFailureState,
  previewRecordSummary,
  previewWriteFields,
  concurrencyProtection,
  MissingRequiredFieldsError,
  type MissingCreateField,
} from '../utils/write-safety.js';
import { confirmShape, lineItemsNotesShape, resolvedLookupNoteShape } from './_schemas.js';
import { getDisplayColumn } from '../utils/display.js';
import { assertSafeIdentifier, escapeODataString, guidLiteral, isGuid } from '../utils/odata.js';
import { enrichLineItem, lineNotesText, lineConfig, recalcParentTotals } from '../workflows/line-items.js';

const modeShape = z.enum(['batch', 'single']).describe('batch — одним $batch, single — по одному запросу');
const itemErrorShape = z.object({
  index: z.number().int(),
  reason: z.string(),
  missing_fields: z.array(z.object({ name: z.string(), caption: z.string(), type: z.string() })).optional(),
});

/** Сколько записей сверяется одним GET-запросом (длина URL). */
const QUERY_CHUNK = 40;

function modeText(mode: 'batch' | 'single'): string {
  return mode === 'batch' ? 'одним $batch' : 'по одному запросу ($batch на инстансе не работает)';
}

type BulkResponse = {
  id?: string;
  status: number;
  body: unknown;
  state?: 'completed' | 'failed' | 'not_executed' | 'outcome_unknown';
};
interface Outcome {
  index: number;
  request_id: string;
  record_id: string;
  state: 'succeeded' | 'failed' | 'not_executed' | 'outcome_unknown';
  status?: number;
  body?: unknown;
  error?: string;
}
const outcomeShape = z.object({
  index: z.number().int(),
  request_id: z.string(),
  record_id: z.string(),
  state: z.enum(['succeeded', 'failed', 'not_executed', 'outcome_unknown']),
  status: z.number().optional(),
  body: z.unknown().optional(),
  error: z.string().optional(),
});
const safetyShape = {
  confirmation_token: z.string().optional(),
  requires_confirmation: z.boolean().optional(),
  code: z.string().optional(),
  records: z.array(z.object({ id: z.string(), display_value: z.string() })).optional(),
  concurrency_protection: z.enum(['etag', 'snapshot_only']).optional(),
  outcomes: z.array(outcomeShape).optional(),
  operation_ids: z.array(z.string()).optional(),
  changes: z
    .array(
      z.object({
        id: z.string(),
        fields: z.array(z.object({ field: z.string(), caption: z.string(), value: z.unknown() })),
      })
    )
    .optional(),
};
type ItemError = { index: number; reason: string; missing_fields?: MissingCreateField[] };
type BulkOp = {
  index: number;
  method: 'POST' | 'PATCH' | 'DELETE';
  url: string;
  body?: Record<string, unknown>;
  record_id: string;
  headers?: Record<string, string>;
};

const isOk = (r: BulkResponse): boolean => r.status >= 200 && r.status < 300;

function errorOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function preparationError(index: number, error: unknown, prefix = ''): ItemError {
  return {
    index,
    reason: prefix + errorOf(error),
    ...(error instanceof MissingRequiredFieldsError ? { missing_fields: error.missingFields } : {}),
  };
}

/** Текст ошибки подзапроса: сообщение BPMSoft, а не сырой JSON. */
function responseError(r: BulkResponse): string {
  const status = r.status ? `HTTP ${r.status}` : 'сеть';
  const message =
    parseODataError(r.body) ??
    (typeof r.body === 'string' ? r.body : r.body == null ? '' : JSON.stringify(r.body)).slice(0, 300);
  return message ? `${status} — ${message}` : status;
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function errorLines(errors: ItemError[], label: (index: number) => string): string[] {
  if (errors.length === 0) return [];
  return [
    '',
    'Ошибки:',
    ...[...errors].sort((a, b) => a.index - b.index).map((e) => `  ${label(e.index)}: ${e.reason}`),
  ];
}

/** Ответ «ничего не отправлено»: без continue_on_error ошибки подготовки останавливают всё. */
function abortedBeforeSend(
  title: string,
  errors: ItemError[],
  label: (index: number) => string
): CallToolResult {
  const lines = [
    `${title}: ничего не отправлено — ошибки при подготовке (${errors.length}).`,
    ...errorLines(errors, label),
    '',
    'Исправьте эти элементы или повторите с continue_on_error=true, чтобы выполнить остальные.',
  ];
  const missing = errors.flatMap((error) => error.missing_fields ?? []);
  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    structuredContent: {
      success: false,
      code: 'validation',
      error: 'Пакет не отправлен: ошибки подготовки.',
      errors,
      ...(missing.length ? { missing_fields: missing } : {}),
    },
    isError: true,
  };
}

/**
 * Выполняет операции и раскладывает ответы по исходным индексам. Операции без ответа
 * (остановка на первой ошибке) попадают в notRun.
 */
async function runOps(
  services: ServiceContainer,
  collection: string,
  ops: BulkOp[],
  continueOnError: boolean
): Promise<{
  mode?: 'batch' | 'single';
  ok: Map<number, BulkResponse>;
  errors: ItemError[];
  notRun: number[];
  outcomes: Outcome[];
}> {
  const ok = new Map<number, BulkResponse>();
  const errors: ItemError[] = [];
  if (ops.length === 0) return { ok, errors, notRun: [], outcomes: [] };
  const metadata = await services.metadataManager.getEntityMetadata(collection);
  const numericProperties = metadata.properties.filter(
    (property) => property.type === 'Edm.Decimal' || property.type === 'Edm.Int64'
  );
  const result = await services.odataClient.executeBulk(
    ops.map(({ method, url, body, headers }) => {
      const numericFields = numericProperties
        .filter((property) => body && property.name in body)
        .map((property) => property.name);
      return {
        method,
        url,
        ...(body ? { body } : {}),
        ...(headers ? { headers } : {}),
        ...(numericFields.length ? { numericFields } : {}),
      };
    }),
    continueOnError,
    services.odataClient.buildCollectionPath(collection)
  );
  const outcomes = ops.map((op, i): Outcome => {
    const requestId = String(i + 1);
    const responses = result.responses.filter((response) => response.id === requestId);
    if (responses.length !== 1) {
      errors.push({
        index: op.index,
        reason: 'Неопределённый ответ: отсутствует или дублируется request_id.',
      });
      return { index: op.index, request_id: requestId, record_id: op.record_id, state: 'outcome_unknown' };
    }
    const response = responses[0];
    const actualId = idOf(response.body);
    const mismatch =
      op.method === 'POST' && actualId !== null && actualId.toLowerCase() !== op.record_id.toLowerCase();
    const state =
      response.state === 'not_executed' || response.state === 'outcome_unknown'
        ? response.state
        : mismatch
          ? 'outcome_unknown'
          : isOk(response)
            ? 'succeeded'
            : response.status >= 400
              ? 'failed'
              : 'outcome_unknown';
    if (state === 'succeeded') ok.set(op.index, response);
    else
      errors.push({
        index: op.index,
        reason: mismatch
          ? 'Сервер вернул другой UUID. Проверьте запись перед повтором.'
          : state === 'not_executed'
            ? 'Операция не выполнена.'
            : responseError(response),
      });
    return {
      index: op.index,
      request_id: requestId,
      record_id: op.record_id,
      state,
      status: response.status,
      body: response.body,
    };
  });
  return {
    mode: result.mode,
    ok,
    errors,
    outcomes,
    notRun: outcomes.filter((outcome) => outcome.state === 'not_executed').map((outcome) => outcome.index),
  };
}

function idOf(body: unknown): string | null {
  const id = (body as Record<string, unknown> | null)?.Id;
  return typeof id === 'string' ? id : null;
}

function literal(value: unknown, isGuidColumn: boolean, version: 3 | 4): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  if (typeof value !== 'string') return null;
  if (isGuidColumn) return isGuid(value) ? guidLiteral(value, version) : null;
  return `'${escapeODataString(value)}'`;
}

const norm = (v: unknown): string =>
  String(v ?? '')
    .trim()
    .toLowerCase();

/**
 * Для каждой записи — Id уже существующих записей с теми же значениями в match_on.
 * Точный eq на сервере, сравнение без учёта регистра — на клиенте.
 */
async function findExisting(
  services: ServiceContainer,
  collection: string,
  columns: Array<{ name: string; guid: boolean }>,
  records: Array<{ index: number; data: Record<string, unknown> }>
): Promise<Map<number, string[]>> {
  const version = services.config.odata_version;
  const found = new Map<number, string[]>();
  const keyed = records
    .map((r) => ({ ...r, lits: columns.map((c) => literal(r.data[c.name], c.guid, version)) }))
    .filter((r) => r.lits.every((l) => l !== null));

  for (const chunk of chunks(keyed, QUERY_CHUNK)) {
    const filter = chunk
      .map((r) => `(${columns.map((c, i) => `${c.name} eq ${r.lits[i]}`).join(' and ')})`)
      .join(' or ');
    const response = await services.odataClient.getRecords<Record<string, unknown>>(
      collection,
      {
        $filter: filter,
        $select: ['Id', ...columns.map((c) => c.name)].join(','),
        $top: 1001,
        $count: true,
      },
      true,
      1001
    );
    if (
      response['@odata.nextLink'] ||
      response.value.length > 1000 ||
      (response['@odata.count'] !== undefined && response['@odata.count'] > response.value.length)
    )
      throw new BpmApiError('Поиск существующих записей неполон; пакет не отправлен.', 400, collection);
    for (const r of chunk) {
      const ids = response.value
        .filter((row) => columns.every((c) => norm(row[c.name]) === norm(r.data[c.name])))
        .map((row) => String(row.Id));
      if (ids.length > 0) found.set(r.index, ids);
    }
  }
  return found;
}

/** Пересчёт родителей строк, записанных успешно: по одному разу на родителя. */
async function recalcDone(
  services: ServiceContainer,
  collection: string,
  parents: Map<number, string[]>,
  ok: Map<number, BulkResponse>,
  outcomes: Outcome[]
): Promise<string[]> {
  if (!lineConfig(collection)?.parent) return [];
  if (outcomes.some((outcome) => outcome.state === 'outcome_unknown'))
    return [
      'Суммы родителей не пересчитаны: исход одного из изменений неопределён. Проверьте outcomes перед пересчётом.',
    ];
  const done = [...parents].filter(([index]) => ok.has(index)).flatMap(([, ids]) => ids);
  return recalcParentTotals(services, collection, done);
}

/** Имена записей по Id одним запросом на чанк; недоступность схемы — пустой результат. */
async function fetchNames(
  services: ServiceContainer,
  collection: string,
  column: string,
  ids: string[]
): Promise<Map<string, string>> {
  const version = services.config.odata_version;
  const names = new Map<string, string>();
  for (const chunk of chunks([...new Set(ids)], QUERY_CHUNK)) {
    const response = await services.odataClient.getRecords<Record<string, unknown>>(collection, {
      $filter: chunk.map((id) => `Id eq ${guidLiteral(id, version)}`).join(' or '),
      $select: `Id,${column}`,
      $top: chunk.length,
    });
    for (const row of response.value) names.set(String(row.Id).toLowerCase(), String(row[column] ?? ''));
  }
  return names;
}

export function registerBatchTools(server: McpServer, services: ServiceContainer): void {
  // bpm_batch_create
  {
    const meta = getTool('bpm_batch_create');
    server.registerTool(
      meta.name,
      {
        title: meta.title,
        description: meta.description,
        inputSchema: {
          collection: z.string().describe('Имя коллекции (EntitySet)'),
          records: z
            .array(z.record(z.string(), z.unknown()))
            .min(1)
            .max(1000)
            .describe('Массив записей для создания (lookup-поля резолвятся)'),
          continue_on_error: z
            .boolean()
            .optional()
            .describe(
              'Не прерывать на ошибке: запись с ошибкой пропускается и попадает в отчёт по номеру, остальные создаются'
            ),
          match_on: z
            .array(z.string())
            .optional()
            .describe(
              'Колонки, по которым запись считается уже существующей (например ["Name"] или ["Email"]). Сравнение без учёта регистра'
            ),
          if_exists: z
            .enum(['skip', 'update', 'error'])
            .optional()
            .describe(
              'Что делать с найденной по match_on записью: skip — не создавать (по умолчанию), update — обновить её данными из records, error — ошибка по этой записи'
            ),
          idempotency_key: z.string().trim().min(1).max(200).optional(),
          confirm: confirmParam,
          confirmation_token: confirmationTokenParam,
        },
        outputSchema: {
          ...safetyShape,
          collection: z.string(),
          total: z.number().int(),
          succeeded: z.number().int(),
          failed: z.number().int(),
          created: z.array(z.union([z.string(), z.null()])).describe('Id созданной записи по индексу входа'),
          existing: z
            .array(z.union([z.string(), z.null()]))
            .optional()
            .describe('Id уже существующей записи (match_on) по индексу входа'),
          updated: z
            .array(z.union([z.string(), z.null()]))
            .optional()
            .describe('Id обновлённой записи (if_exists=update) по индексу входа'),
          errors: z.array(itemErrorShape).optional(),
          first_failed_index: z.number().int().nullable(),
          mode: modeShape.optional(),
          resolved_lookups: z.array(resolvedLookupNoteShape).optional(),
          line_items_notes: lineItemsNotesShape,
        },
        annotations: meta.annotations,
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        const plannedOps: BulkOp[] = [];
        let executionStarted = false;
        try {
          await services.authManager.ensureAuthenticated();
          const collection = await resolveCollectionName(services, params.collection);
          const total = params.records.length;
          validateIdempotencyKey(params.idempotency_key);
          if (total > 1000) throw new BpmApiError('Пакет ограничен 1000 элементами.', 400, collection);
          const continueOnError = params.continue_on_error ?? false;

          if (total === 0) {
            return {
              content: [{ type: 'text', text: 'Массив записей пуст. Нечего создавать.' }],
              isError: true,
            };
          }

          // Колонки match_on сверяются со схемой до любых запросов.
          const matchColumns: Array<{ name: string; guid: boolean }> = [];
          if (params.match_on?.length) {
            const entity = await services.metadataManager.getEntityMetadata(collection);
            for (const raw of params.match_on) {
              const ref = await services.metadataManager.resolveFieldReference(collection, raw);
              if (ref.name === null) throw new UnknownFieldError(raw, collection, ref.suggestions);
              assertSafeIdentifier(ref.name, 'match_on');
              const prop = entity.properties.find((p) => p.name === ref.name);
              matchColumns.push({ name: ref.name, guid: Boolean(prop?.type.endsWith('Guid')) });
            }
          }

          const displayColumn = (await getDisplayColumn(services.metadataManager, collection)) ?? 'Name';
          const resolved: Array<Record<string, unknown> | null> = new Array(total).fill(null);
          const label = (i: number): string => {
            const value = params.records[i]?.[displayColumn] ?? resolved[i]?.[displayColumn];
            return value == null || value === '' ? `#${i + 1}` : `#${i + 1} ${String(value)}`;
          };

          const allNotes: ResolvedLookupNote[] = [];
          const allCoerced: CoercedValueNote[] = [];
          const errors: ItemError[] = [];
          const lineNotes: string[] = [];
          const lineParents = new Map<number, string[]>();
          for (let i = 0; i < total; i++) {
            try {
              const r = await services.lookupResolver.resolveDataLookups(collection, params.records[i]);
              resolved[i] = r.data;
              allNotes.push(...r.notes);
              allCoerced.push(...(r.coerced ?? []).map((c) => ({ ...c, field: `#${i + 1} ${c.field}` })));
            } catch (error) {
              errors.push(preparationError(i, error, 'ошибка резолвинга lookup: '));
            }
          }

          const ifExists = params.if_exists ?? 'skip';
          const existing: Array<string | null> = new Array(total).fill(null);
          const ops: BulkOp[] = plannedOps;
          const snapshots: Record<string, unknown>[] = [];
          const collectionPath = services.odataClient.buildCollectionPath(collection);
          const ready = resolved
            .map((data, index) => (data ? { index, data } : null))
            .filter((r): r is { index: number; data: Record<string, unknown> } => r !== null);
          const matches = matchColumns.length
            ? await findExisting(services, collection, matchColumns, ready)
            : new Map<number, string[]>();
          const duplicateKeys = new Map<string, number>();
          const fallbackKey = `batch:${operationFingerprint({ collection, records: params.records, match_on: params.match_on })}`;

          for (const { index, data } of ready) {
            if (matchColumns.length) {
              const key = operationFingerprint(matchColumns.map((column) => norm(data[column.name])));
              const previous = duplicateKeys.get(key);
              if (previous !== undefined) {
                errors.push({
                  index,
                  reason: `Та же запись match_on уже передана в элементе #${previous + 1}.`,
                });
                continue;
              }
              duplicateKeys.set(key, index);
            }
            const ids = matches.get(index);
            if (!ids) {
              try {
                const line = await enrichLineItem(services, collection, data);
                await validateRequiredCreateFields(services, collection, line.data);
                const key =
                  params.idempotency_key ??
                  (ifExists === 'update' && line.data.Id === undefined ? fallbackKey : undefined);
                const id = creationRecordId(services, line.data, key, `${collection}:batch-create:${index}`);
                ops.push({
                  index,
                  method: 'POST',
                  url: collectionPath,
                  record_id: id,
                  body: { ...line.data, Id: id },
                });
                lineNotes.push(...line.notes.map((note) => `#${index + 1} ${note}`));
                if (line.parents.length) lineParents.set(index, line.parents);
              } catch (error) {
                errors.push(preparationError(index, error));
              }
              continue;
            }
            if (ids.length > 1) {
              errors.push({
                index,
                reason: `уже есть ${ids.length} записей с такими значениями: ${ids.join(', ')}`,
              });
              continue;
            }
            existing[index] = ids[0];
            if (ifExists === 'error') errors.push({ index, reason: `уже есть: ${ids[0]}` });
            else if (ifExists === 'update') {
              if (data.Id !== undefined && String(data.Id).toLowerCase() !== ids[0].toLowerCase()) {
                errors.push({ index, reason: 'Id передан для другой записи; UUID менять нельзя.' });
                continue;
              }
              const snapshot = await services.odataClient.getRecord<Record<string, unknown>>(
                collection,
                ids[0]
              );
              snapshots.push(snapshot);
              const patch = { ...data };
              delete patch.Id;
              if (!Object.keys(patch).length) {
                errors.push({ index, reason: 'Обновление не содержит изменяемых полей.' });
                continue;
              }
              const line = await enrichLineItem(services, collection, patch, {
                id: ids[0],
                record: snapshot,
              });
              lineNotes.push(...line.notes.map((note) => `#${index + 1} ${note}`));
              if (line.parents.length) lineParents.set(index, line.parents);
              const etag = recordEtag(snapshot);
              ops.push({
                index,
                method: 'PATCH',
                url: services.odataClient.buildRecordPath(collection, ids[0]),
                body: line.data,
                record_id: ids[0],
                ...(etag ? { headers: { 'If-Match': etag } } : {}),
              });
            }
          }

          if (errors.length > 0 && !continueOnError) {
            return abortedBeforeSend(`Пакетное создание в ${collection}`, errors, label);
          }
          if (new Set(ops.map((op) => op.record_id)).size !== ops.length)
            throw new BpmApiError('Одна запись указана несколько раз в пакете.', 400, collection);
          if (ops.some((op) => op.method === 'PATCH')) {
            const operation = {
              tool: meta.name,
              collection,
              records: params.records,
              match_on: params.match_on,
              if_exists: ifExists,
              idempotency_key: params.idempotency_key,
              continue_on_error: continueOnError,
              snapshots,
              ops,
              errors,
            };
            if (params.confirm !== true)
              return confirmationResponse(
                meta.name,
                [
                  `План пакета ${collection}: создание ${ops.filter((op) => op.method === 'POST').length}, обновление ${snapshots.length} существующих записей.`,
                  ...previewRecordSummary(snapshots).map(
                    (record) => `${record.display_value} (${record.id})`
                  ),
                ],
                {
                  collection,
                  total,
                  succeeded: 0,
                  failed: errors.length,
                  first_failed_index: errors[0]?.index ?? null,
                  created: new Array(total).fill(null),
                  existing,
                  confirmation_token: createConfirmationPlan(services, operation),
                  records: previewRecordSummary(snapshots),
                  concurrency_protection: concurrencyProtection(snapshots),
                  operation_ids: ops.map((op) => op.record_id),
                  changes: await Promise.all(
                    ops
                      .filter((op) => op.method === 'PATCH')
                      .map(async (op) => ({
                        id: op.record_id,
                        fields: await previewWriteFields(services, collection, op.body!),
                      }))
                  ),
                }
              );
            consumeConfirmationPlan(services, params.confirmation_token, operation);
          }

          plannedOps.splice(0, plannedOps.length, ...ops);
          executionStarted = true;
          const run = await runOps(services, collection, ops, continueOnError);
          errors.push(...run.errors);
          lineNotes.push(...(await recalcDone(services, collection, lineParents, run.ok, run.outcomes)));

          const created: Array<string | null> = new Array(total).fill(null);
          const updated: Array<string | null> = new Array(total).fill(null);
          for (const op of ops) {
            const r = run.ok.get(op.index);
            if (!r) continue;
            if (op.method === 'POST') created[op.index] = op.record_id;
            else updated[op.index] = existing[op.index];
          }
          const createdCount = created.filter((c) => c !== null).length;
          const updatedCount = updated.filter((u) => u !== null).length;
          const skippedExisting = existing
            .map((id, i) => (id && ifExists === 'skip' ? i : -1))
            .filter((i) => i >= 0);

          const lines = [
            `Пакетное создание в ${collection}:`,
            `  Всего записей: ${total}`,
            ...(run.mode ? [`  Способ: ${modeText(run.mode)}`] : []),
            `  Создано: ${createdCount}`,
            ...(matchColumns.length
              ? [
                  `  Уже были (${matchColumns.map((c) => c.name).join(', ')}): ${existing.filter(Boolean).length}`,
                ]
              : []),
            ...(updatedCount ? [`  Обновлено существующих: ${updatedCount}`] : []),
            `  Ошибок: ${errors.length}`,
          ];
          if (run.notRun.length > 0) {
            lines.push(
              `  Не выполнено (остановлено на первой ошибке): ${run.notRun.map((i) => `#${i + 1}`).join(', ')} — повторите их с continue_on_error=true`
            );
          }
          // Id нужны модели для следующего шага, а structuredContent читают не все клиенты.
          const itemLines: string[] = [];
          created.forEach((id, i) => {
            if (id !== null) itemLines.push(`  ${label(i)} → ${id}`);
          });
          updated.forEach((id, i) => {
            if (id !== null) itemLines.push(`  ${label(i)} — обновлена: ${id}`);
          });
          skippedExisting.forEach((i) => itemLines.push(`  ${label(i)} — уже есть: ${existing[i]}`));
          if (itemLines.length) lines.push('', ...itemLines);
          const notesLine = lookupNotesText(allNotes);
          if (notesLine) lines.push(notesLine);
          const coercedLine = coercedText(allCoerced);
          if (coercedLine) lines.push(coercedLine);
          if (lineNotes.length) lines.push(lineNotesText(lineNotes));
          lines.push(...errorLines(errors, label));

          const sortedErrors = [...errors].sort((a, b) => a.index - b.index);
          return {
            content: [{ type: 'text', text: lines.join('\n') }],
            isError: errors.length > 0,
            structuredContent: {
              collection,
              total,
              outcomes: run.outcomes,
              operation_ids: ops.map((op) => op.record_id),
              succeeded: createdCount,
              failed: errors.length,
              created,
              ...(matchColumns.length ? { existing, updated } : {}),
              ...(errors.length ? { errors: sortedErrors } : {}),
              first_failed_index: sortedErrors[0]?.index ?? null,
              ...(run.mode ? { mode: run.mode } : {}),
              ...(allNotes.length ? { resolved_lookups: lookupNotesStructured(allNotes) } : {}),
              ...(lineNotes.length ? { line_items_notes: lineNotes } : {}),
            },
          };
        } catch (error) {
          const toolError = {
            ...writeToolError(error, params.collection),
            operation_ids: plannedOps.map((op) => op.record_id),
            outcomes: plannedOps.map((op, i) => ({
              index: op.index,
              request_id: String(i + 1),
              record_id: op.record_id,
              state:
                executionStarted && writeFailureState(error) === 'outcome_unknown'
                  ? 'outcome_unknown'
                  : 'not_executed',
            })),
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

  // bpm_batch_update
  {
    const meta = getTool('bpm_batch_update');
    server.registerTool(
      meta.name,
      {
        title: meta.title,
        description: meta.description,
        inputSchema: {
          collection: z.string().describe('Имя коллекции (EntitySet)'),
          updates: z
            .array(
              z.object({
                id: z.string().describe('UUID записи или её название (Name/Title) — сервер найдёт Id сам'),
                data: z.record(z.string(), z.unknown()),
                expected_etag: z.string().optional(),
              })
            )
            .min(1)
            .max(1000)
            .describe('Массив обновлений [{id, data}]'),
          continue_on_error: z
            .boolean()
            .optional()
            .describe('Не прерывать на ошибке: запись, которую не удалось найти или обновить, пропускается'),
          confirm: confirmParam,
          confirmation_token: confirmationTokenParam,
        },
        outputSchema: {
          ...safetyShape,
          collection: z.string(),
          total: z.number().int(),
          succeeded: z.number().int(),
          failed: z.number().int(),
          ids: z
            .array(z.union([z.string(), z.null()]))
            .optional()
            .describe('Разрешённый Id по индексу входа'),
          errors: z.array(itemErrorShape).optional(),
          first_failed_index: z.number().int().nullable(),
          mode: modeShape.optional(),
          resolved_lookups: z.array(resolvedLookupNoteShape).optional(),
          line_items_notes: lineItemsNotesShape,
        },
        annotations: meta.annotations,
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        const plannedOps: BulkOp[] = [];
        let executionStarted = false;
        try {
          await services.authManager.ensureAuthenticated();
          const collection = await resolveCollectionName(services, params.collection);
          const total = params.updates.length;
          if (total > 1000) throw new BpmApiError('Пакет ограничен 1000 элементами.', 400, collection);
          const continueOnError = params.continue_on_error ?? false;

          if (total === 0) {
            return { content: [{ type: 'text', text: 'Массив обновлений пуст.' }], isError: true };
          }

          const ids: Array<string | null> = new Array(total).fill(null);
          const matchedNotes: string[] = [];
          const label = (i: number): string => `#${i + 1} (${params.updates[i]?.id})`;
          const ops: BulkOp[] = plannedOps;
          const snapshots: Record<string, unknown>[] = [];
          const errors: ItemError[] = [];
          const allNotes: ResolvedLookupNote[] = [];
          const allCoerced: CoercedValueNote[] = [];
          const lineNotes: string[] = [];
          const lineParents = new Map<number, string[]>();
          for (let i = 0; i < total; i++) {
            const update = params.updates[i];
            try {
              const ref = await resolveRecordId(services, collection, update.id);
              ids[i] = ref.id;
              if (ref.matched !== undefined) matchedNotes.push(`«${update.id}» → ${ref.matched} (${ref.id})`);
            } catch (error) {
              errors.push({ index: i, reason: `запись не найдена: ${errorOf(error)}` });
              continue;
            }
            try {
              const resolved = await services.lookupResolver.resolveDataLookups(collection, update.data);
              if (!Object.keys(resolved.data).length || 'Id' in resolved.data)
                throw new BpmApiError(
                  'Обновление должно содержать поля и не может менять UUID.',
                  400,
                  collection
                );
              const snapshot = await services.odataClient.getRecord<Record<string, unknown>>(
                collection,
                ids[i]!
              );
              snapshots.push(snapshot);
              if (update.expected_etag !== undefined)
                await services.odataClient.assertExpectedEtag(collection, ids[i]!, update.expected_etag);
              allNotes.push(...resolved.notes);
              allCoerced.push(
                ...(resolved.coerced ?? []).map((c) => ({ ...c, field: `#${i + 1} ${c.field}` }))
              );
              const line = await enrichLineItem(services, collection, resolved.data, {
                id: ids[i]!,
                record: snapshot,
              });
              lineNotes.push(...line.notes.map((n) => `#${i + 1} ${n}`));
              if (line.parents.length) lineParents.set(i, line.parents);
              ops.push({
                index: i,
                method: 'PATCH',
                url: services.odataClient.buildRecordPath(collection, ids[i]!),
                body: line.data,
                record_id: ids[i]!,
                ...((update.expected_etag ?? recordEtag(snapshot))
                  ? { headers: { 'If-Match': update.expected_etag ?? recordEtag(snapshot)! } }
                  : {}),
              });
            } catch (error) {
              errors.push(preparationError(i, error, 'ошибка резолвинга lookup: '));
            }
          }

          if (errors.length > 0 && !continueOnError) {
            return abortedBeforeSend(`Пакетное обновление в ${collection}`, errors, label);
          }
          if (new Set(ops.map((op) => op.record_id)).size !== ops.length)
            throw new BpmApiError('Одна запись указана несколько раз в пакете.', 400, collection);
          const operation = {
            tool: meta.name,
            collection,
            updates: params.updates,
            continue_on_error: continueOnError,
            snapshots,
            ops,
            errors,
          };
          if (params.confirm !== true)
            return confirmationResponse(
              meta.name,
              [
                `Будет обновлено ${ops.length} записей в ${collection}:`,
                ...previewRecordSummary(snapshots).map((record) => `${record.display_value} (${record.id})`),
              ],
              {
                collection,
                total,
                succeeded: 0,
                failed: errors.length,
                first_failed_index: errors[0]?.index ?? null,
                ids,
                records: previewRecordSummary(snapshots),
                concurrency_protection: concurrencyProtection(snapshots),
                confirmation_token: createConfirmationPlan(services, operation),
                changes: await Promise.all(
                  ops.map(async (op) => ({
                    id: op.record_id,
                    fields: await previewWriteFields(services, collection, op.body!),
                  }))
                ),
              }
            );
          consumeConfirmationPlan(services, params.confirmation_token, operation);

          plannedOps.splice(0, plannedOps.length, ...ops);
          executionStarted = true;
          const run = await runOps(services, collection, ops, continueOnError);
          errors.push(...run.errors);
          lineNotes.push(...(await recalcDone(services, collection, lineParents, run.ok, run.outcomes)));

          const lines = [
            `Пакетное обновление в ${collection}:`,
            `  Всего: ${total}`,
            ...(run.mode ? [`  Способ: ${modeText(run.mode)}`] : []),
            `  Успешно обновлено: ${run.ok.size}`,
            `  Ошибок: ${errors.length}`,
          ];
          if (run.notRun.length > 0) {
            lines.push(
              `  Не выполнено (остановлено на первой ошибке): ${run.notRun.map((i) => `#${i + 1}`).join(', ')} — повторите их с continue_on_error=true`
            );
          }
          if (matchedNotes.length) lines.push(`  Найдены по названию: ${matchedNotes.join('; ')}`);
          const notesLine = lookupNotesText(allNotes);
          if (notesLine) lines.push(notesLine);
          const coercedLine = coercedText(allCoerced);
          if (coercedLine) lines.push(coercedLine);
          if (lineNotes.length) lines.push(lineNotesText(lineNotes));
          lines.push(...errorLines(errors, label));

          const sortedErrors = [...errors].sort((a, b) => a.index - b.index);
          return {
            content: [{ type: 'text', text: lines.join('\n') }],
            isError: errors.length > 0,
            structuredContent: {
              collection,
              total,
              succeeded: run.ok.size,
              outcomes: run.outcomes,
              operation_ids: ops.map((op) => op.record_id),
              failed: errors.length,
              ids,
              ...(errors.length ? { errors: sortedErrors } : {}),
              first_failed_index: sortedErrors[0]?.index ?? null,
              ...(run.mode ? { mode: run.mode } : {}),
              ...(allNotes.length ? { resolved_lookups: lookupNotesStructured(allNotes) } : {}),
              ...(lineNotes.length ? { line_items_notes: lineNotes } : {}),
            },
          };
        } catch (error) {
          const toolError = {
            ...writeToolError(error, params.collection),
            operation_ids: plannedOps.map((op) => op.record_id),
            outcomes: plannedOps.map((op, i) => ({
              index: op.index,
              request_id: String(i + 1),
              record_id: op.record_id,
              state:
                executionStarted && writeFailureState(error) === 'outcome_unknown'
                  ? 'outcome_unknown'
                  : 'not_executed',
            })),
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

  // bpm_batch_delete
  {
    const meta = getTool('bpm_batch_delete');
    server.registerTool(
      meta.name,
      {
        title: meta.title,
        description: meta.description,
        inputSchema: {
          collection: z.string().describe('Имя коллекции (EntitySet)'),
          ids: z
            .array(z.string())
            .min(1)
            .max(1000)
            .describe('UUID записей или их точные названия (Name/Title); нечёткое совпадение не удаляется'),
          continue_on_error: z
            .boolean()
            .optional()
            .describe('Не прерывать на ошибке: ненайденные записи пропускаются, остальные удаляются'),
          confirm: confirmParam,
          confirmation_token: confirmationTokenParam,
        },
        outputSchema: {
          ...confirmShape,
          ...safetyShape,
          collection: z.string(),
          total: z.number().int().optional(),
          succeeded: z.number().int().optional(),
          failed: z.number().int().optional(),
          first_failed_index: z.number().int().nullable().optional(),
          mode: modeShape.optional(),
          ids: z.array(z.string()).optional(),
          count: z.number().int().optional(),
          items: z
            .array(z.object({ index: z.number().int(), input: z.string(), id: z.string(), name: z.string() }))
            .optional(),
          errors: z.array(itemErrorShape).optional(),
          line_items_notes: lineItemsNotesShape,
        },
        annotations: meta.annotations,
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        const plannedOps: BulkOp[] = [];
        let executionStarted = false;
        try {
          await services.authManager.ensureAuthenticated();
          const collection = await resolveCollectionName(services, params.collection);
          const total = params.ids.length;
          if (total > 1000) throw new BpmApiError('Пакет ограничен 1000 элементами.', 400, collection);
          const continueOnError = params.continue_on_error ?? false;
          if (total === 0) {
            return { content: [{ type: 'text', text: 'Массив ID пуст. Нечего удалять.' }], isError: true };
          }

          // Удаление — только точное совпадение: нечёткий матч мог бы снести не ту запись.
          const column = (await getDisplayColumn(services.metadataManager, collection)) ?? 'Name';
          const items: Array<{ index: number; input: string; id: string; name: string }> = [];
          const errors: ItemError[] = [];
          for (let i = 0; i < total; i++) {
            const input = params.ids[i].trim();
            if (isGuid(input)) {
              items.push({ index: i, input, id: input, name: '' });
              continue;
            }
            try {
              const r = await services.lookupResolver.resolve(collection, input, column, { fuzzy: false });
              if (r.resolved && r.id) {
                items.push({ index: i, input, id: r.id, name: r.candidates[0]?.displayValue ?? input });
              } else if (r.matchCount > 1) {
                errors.push({
                  index: i,
                  reason: `несколько записей с ${column}="${input}" (${r.matchCount}) — передайте UUID: ${r.candidates.map((c) => c.id).join(', ')}`,
                });
              } else {
                errors.push({ index: i, reason: `нет записи с ${column}="${input}" (точное совпадение)` });
              }
            } catch (error) {
              errors.push({ index: i, reason: errorOf(error) });
            }
          }

          // Имена для UUID — чтобы пользователь видел, что именно удаляется.
          const byUuid = items.filter((it) => !it.name);
          if (byUuid.length) {
            let names: Map<string, string> | null = null;
            try {
              names = await fetchNames(
                services,
                collection,
                column,
                byUuid.map((it) => it.id)
              );
            } catch {
              // Имена не получить (схема/колонка недоступны) — превью покажет только Id.
            }
            for (const it of names ? byUuid : []) {
              const name = names!.get(it.id.toLowerCase());
              if (name === undefined) errors.push({ index: it.index, reason: `запись ${it.id} не найдена` });
              else it.name = name;
            }
          }
          const found = items.filter((it) => !errors.some((e) => e.index === it.index));
          const label = (i: number): string => `#${i + 1} (${params.ids[i]})`;
          const itemLine = (it: { index: number; name: string; id: string }): string =>
            `  #${it.index + 1} ${it.name || '(без названия)'} (${it.id})`;

          if (errors.length > 0 && !continueOnError) {
            return abortedBeforeSend(`Пакетное удаление из ${collection}`, errors, label);
          }

          if (new Set(found.map((item) => item.id.toLowerCase())).size !== found.length)
            throw new BpmApiError('Одна запись указана несколько раз в пакете.', 400, collection);
          const snapshots = await Promise.all(
            found.map((item) => services.odataClient.getRecord<Record<string, unknown>>(collection, item.id))
          );
          const operation = {
            tool: meta.name,
            collection,
            inputs: params.ids,
            items: found,
            snapshots,
            continue_on_error: continueOnError,
            errors,
          };
          if (params.confirm !== true) {
            return confirmationResponse(
              meta.name,
              [
                `Будет удалено ${found.length} записей из ${collection}:`,
                ...found.map(itemLine),
                ...(errors.length
                  ? [`Будут пропущены (${errors.length}):`, ...errorLines(errors, label).slice(2)]
                  : []),
              ],
              {
                collection,
                ids: found.map((it) => it.id),
                count: found.length,
                items: found,
                records: previewRecordSummary(snapshots),
                concurrency_protection: concurrencyProtection(snapshots),
                confirmation_token: createConfirmationPlan(services, operation),
                ...(errors.length ? { errors } : {}),
              }
            );
          }
          consumeConfirmationPlan(services, params.confirmation_token, operation);

          const ops: BulkOp[] = found.map((it) => ({
            index: it.index,
            method: 'DELETE',
            url: services.odataClient.buildRecordPath(collection, it.id),
            record_id: it.id,
            ...(recordEtag(
              snapshots.find((record) => recordId(record).toLowerCase() === it.id.toLowerCase())!
            )
              ? {
                  headers: {
                    'If-Match': recordEtag(
                      snapshots.find((record) => recordId(record).toLowerCase() === it.id.toLowerCase())!
                    )!,
                  },
                }
              : {}),
          }));
          // Родителей берём из подтверждённых полных снимков до удаления.
          const cfg = lineConfig(collection);
          const parents = new Map(
            found.map((item, index) => {
              const parent = cfg?.parent ? snapshots[index][cfg.fk] : undefined;
              return [
                item.index,
                typeof parent === 'string' &&
                isGuid(parent) &&
                parent !== '00000000-0000-0000-0000-000000000000'
                  ? [parent]
                  : [],
              ];
            })
          );
          plannedOps.splice(0, plannedOps.length, ...ops);
          executionStarted = true;
          const run = await runOps(services, collection, ops, continueOnError);
          errors.push(...run.errors);
          const lineNotes = await recalcDone(services, collection, parents, run.ok, run.outcomes);

          const lines = [
            `Пакетное удаление из ${collection}:`,
            `  Всего: ${total}`,
            ...(run.mode ? [`  Способ: ${modeText(run.mode)}`] : []),
            `  Успешно удалено: ${run.ok.size}`,
            `  Ошибок: ${errors.length}`,
          ];
          if (run.notRun.length > 0) {
            lines.push(
              `  Не выполнено (остановлено на первой ошибке): ${run.notRun.map((i) => `#${i + 1}`).join(', ')} — повторите их с continue_on_error=true`
            );
          }
          const deleted = found.filter((it) => run.ok.has(it.index));
          if (deleted.length) lines.push('', 'Удалены:', ...deleted.map(itemLine));
          if (lineNotes.length) lines.push(lineNotesText(lineNotes));
          lines.push(...errorLines(errors, label));

          const sortedErrors = [...errors].sort((a, b) => a.index - b.index);
          return {
            content: [{ type: 'text', text: lines.join('\n') }],
            isError: errors.length > 0,
            structuredContent: {
              collection,
              total,
              succeeded: run.ok.size,
              outcomes: run.outcomes,
              operation_ids: ops.map((op) => op.record_id),
              failed: errors.length,
              first_failed_index: sortedErrors[0]?.index ?? null,
              ...(run.mode ? { mode: run.mode } : {}),
              ids: deleted.map((it) => it.id),
              ...(errors.length ? { errors: sortedErrors } : {}),
              ...(lineNotes.length ? { line_items_notes: lineNotes } : {}),
            },
          };
        } catch (error) {
          const toolError = {
            ...writeToolError(error, params.collection),
            operation_ids: plannedOps.map((op) => op.record_id),
            outcomes: plannedOps.map((op, i) => ({
              index: op.index,
              request_id: String(i + 1),
              record_id: op.record_id,
              state:
                executionStarted && writeFailureState(error) === 'outcome_unknown'
                  ? 'outcome_unknown'
                  : 'not_executed',
            })),
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
}
