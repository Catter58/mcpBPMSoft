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
import { buildValueOrigins } from '../utils/write-safety.js';
import { getTool } from './registry.js';
import {
  notInitialized,
  lookupNotesText,
  lookupNotesStructured,
  resolveCollectionName,
  resolveRecordTarget,
} from './_guards.js';
import { coercedText, type CoercedValueNote } from '../utils/coerce.js';
import { isCalendarDateOnly } from '../utils/coerce.js';
import type { ResolvedLookupNote, ResolutionFieldError } from '../lookup/lookup-resolver.js';
import {
  confirmParam,
  confirmationTokenParam,
  confirmationResponse,
  createConfirmationPlan,
  consumeConfirmationPlan,
  operationFingerprint,
} from '../utils/confirm.js';
import {
  creationRecordIdWithScope,
  recordId,
  recordEtag,
  validateIdempotencyKey,
  writeToolError,
  writeFailureState,
  previewRecordSummary,
  previewWriteFields,
  previewWriteChanges,
  buildClarifications,
  concurrencyProtection,
  MissingRequiredFieldsError,
  type MissingCreateField,
} from '../utils/write-safety.js';
import type { IdempotencyScope } from '../utils/write-safety.js';
import {
  confirmShape,
  lineItemsNotesShape,
  resolvedLookupNoteShape,
  matchBySchema,
  matchedByShape,
  valueOriginShape,
} from './_schemas.js';
import { getDisplayColumn } from '../utils/display.js';
import { assertSafeIdentifier, escapeODataString, guidLiteral, isGuid } from '../utils/odata.js';
import { enrichLineItem, lineNotesText, lineConfig, recalcParentTotals } from '../workflows/line-items.js';
import {
  resolutionErrorBlocker,
  prepareCreateIntent,
  createCreateResolutionContext,
  detectSourceTimezone,
  validateResolvedCreateData,
  type CreateBlocker,
} from '../workflows/create-preparation.js';
import { reservePreparedActivity } from '../workflows/activity-preparation.js';
import { prepareUpdateIntent, type UpdateOperation } from '../workflows/update-preparation.js';
import { isBatchStepReference, planBatchCreateSteps, type BatchCreateStep } from './batch-step-references.js';

const modeShape = z.enum(['batch', 'single']).describe('batch — одним $batch, single — по одному запросу');
const itemErrorShape = z.object({
  index: z.number().int(),
  reason: z.string(),
  missing_fields: z.array(z.object({ name: z.string(), caption: z.string(), type: z.string() })).optional(),
  blockers: z.array(z.record(z.string(), z.unknown())).optional(),
});

/** Сколько записей сверяется одним GET-запросом (длина URL). */
const QUERY_CHUNK = 40;

function modeText(mode: 'batch' | 'single'): string {
  return mode === 'batch' ? 'одним $batch' : 'по одному запросу';
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
  conflict: z
    .object({
      changed: z.array(
        z.object({
          index: z.number().int(),
          id: z.string(),
          fields: z.array(
            z.object({ field: z.string(), before: z.unknown().optional(), current: z.unknown().optional() })
          ),
        })
      ),
    })
    .optional(),
  outcomes: z.array(outcomeShape).optional(),
  operation_ids: z.array(z.string()).optional(),
  verification_args: z
    .array(
      z.object({
        index: z.number().int(),
        collection: z.string(),
        id: z.string(),
        verify: z.object({
          operation: z.enum(['create', 'update', 'delete']),
          expected: z.record(z.string(), z.unknown()).optional(),
        }),
      })
    )
    .optional(),
  changes: z
    .array(
      z.looseObject({
        id: z.string(),
        fields: z.array(z.object({ field: z.string(), caption: z.string(), value: z.unknown() })).optional(),
        index: z.number().int().optional(),
        state: z.string().optional(),
        basis: z.enum(['observed_response', 'requested']).optional(),
        changes: z.array(z.record(z.string(), z.unknown())).optional(),
      })
    )
    .optional(),
};
type ItemError = {
  index: number;
  reason: string;
  missing_fields?: MissingCreateField[];
  blockers?: CreateBlocker[];
};
type BulkOp = {
  index: number;
  method: 'POST' | 'PATCH' | 'DELETE';
  url: string;
  body?: Record<string, unknown>;
  record_id: string;
  headers?: Record<string, string>;
};

interface BatchStepResult {
  index: number;
  alias: string;
  collection: string;
  id: string | null;
  state: 'succeeded' | 'failed' | 'not_executed' | 'outcome_unknown';
  error?: string;
}

interface PreparedBatchStep extends BatchStepResult {
  data?: Record<string, unknown>;
  refs: string[];
}

async function executeBatchCreateSteps(
  services: ServiceContainer,
  toolName: string,
  args: {
    steps: BatchCreateStep[];
    continue_on_error?: boolean;
    idempotency_key?: string;
    idempotency_scope?: IdempotencyScope;
    dry_run?: boolean;
    confirm?: boolean;
    confirmation_token?: string;
  }
): Promise<CallToolResult> {
  const scope = args.idempotency_scope ?? 'session';
  if (scope === 'user' && args.idempotency_key === undefined)
    throw new BpmApiError('idempotency_scope=user требует idempotency_key.', 400);
  const collectionNames = await Promise.all(
    args.steps.map((step) => resolveCollectionName(services, step.collection))
  );
  const plan = planBatchCreateSteps(args.steps, collectionNames);
  const aliases = new Map(plan.steps.map((step, index) => [step.alias, index]));

  // Resolve every field and validate every reference target before preparing or writing any row.
  const canonicalFields: Array<Map<string, string>> = [];
  for (let index = 0; index < plan.steps.length; index++) {
    const collection = collectionNames[index];
    const entity = await services.metadataManager.getEntityMetadata(collection);
    const fields = new Map<string, string>();
    for (const [rawField, value] of Object.entries(plan.steps[index].record)) {
      const ref = await services.metadataManager.resolveFieldReference(collection, rawField);
      if (ref.name === null) throw new UnknownFieldError(rawField, collection, ref.suggestions);
      assertSafeIdentifier(ref.name, 'steps.record');
      const property = entity.properties.find((candidate) => candidate.name === ref.name);
      if (!property) throw new UnknownFieldError(rawField, collection, []);
      if (fields.has(ref.name))
        throw new BpmApiError(
          `Поле "${ref.name}" указано несколько раз в шаге #${index + 1}.`,
          400,
          collection
        );
      fields.set(ref.name, rawField);
      if (isBatchStepReference(value)) {
        const reference = plan.references.get(index)?.find((item) => item.field === rawField);
        const targetIndex = reference ? aliases.get(reference.alias) : undefined;
        if (
          !reference ||
          targetIndex === undefined ||
          !property.isLookup ||
          property.type !== 'Edm.Guid' ||
          !property.lookupCollection ||
          property.lookupCollection.toLowerCase() !== collectionNames[targetIndex].toLowerCase()
        )
          throw new BpmApiError(
            `Ссылка в поле ${ref.name} шага #${index + 1} допустима только для GUID lookup на коллекцию шага alias "${value.$ref}".`,
            400,
            collection
          );
      }
    }
    canonicalFields.push(fields);
  }

  const context = createCreateResolutionContext(services);
  const prepared: PreparedBatchStep[] = plan.steps.map((step, index) => ({
    index,
    alias: step.alias,
    collection: collectionNames[index],
    id: null,
    state: 'not_executed',
    refs: (plan.references.get(index) ?? []).map((ref) => ref.alias),
  }));
  const byAlias = new Map<string, PreparedBatchStep>();
  for (const step of prepared) byAlias.set(step.alias, step);
  const idsByAlias = new Map<string, string>();
  const dataByIndex = new Map<number, Record<string, unknown>>();
  const stepValueOrigins: Array<{
    index: number;
    alias: string;
    field: string;
    source: string;
    observed: boolean;
    value?: unknown;
  }> = [];
  const errors: ItemError[] = [];

  for (const index of plan.order) {
    const input = plan.steps[index];
    const result = prepared[index];
    const refs = plan.references.get(index) ?? [];
    const failedDependency = refs.find(
      (ref) => byAlias.get(ref.alias)?.state !== 'succeeded' && !idsByAlias.has(ref.alias)
    );
    if (failedDependency) {
      result.state = 'not_executed';
      result.error = `Шаг пропущен: зависимость alias "${failedDependency.alias}" не подготовлена.`;
      errors.push({ index, reason: result.error });
      continue;
    }
    try {
      const record: Record<string, unknown> = {};
      for (const [rawField, rawValue] of Object.entries(input.record)) {
        const canonical =
          [...canonicalFields[index]].find(([, source]) => source === rawField)?.[0] ?? rawField;
        const value = isBatchStepReference(rawValue) ? idsByAlias.get(rawValue.$ref)! : rawValue;
        record[canonical] = value;
      }
      const create = await prepareCreateIntent(services, result.collection, record, context);
      if (create.blockers.length)
        throw new BpmApiError(
          create.blockers.map((blocker) => blocker.message).join(' '),
          400,
          result.collection
        );
      const data = create.line.data;
      const identityData = { ...data };
      delete identityData.Id;
      const key = args.idempotency_key
        ? args.idempotency_key
        : `batch-step:${operationFingerprint({ alias: input.alias, collection: result.collection, record: identityData })}`;
      const id = await creationRecordIdWithScope(
        services,
        data,
        key,
        `${result.collection}:batch-step:${input.alias}`,
        scope,
        context
      );
      const originSources = [...create.origins];
      for (const reference of refs) {
        const canonical =
          [...canonicalFields[index]].find(([, source]) => source === reference.field)?.[0] ??
          reference.field;
        const existing = originSources.findIndex((origin) => origin.field === canonical);
        const origin = { field: canonical, source: 'computed' as const };
        if (existing >= 0) originSources[existing] = origin;
        else originSources.push(origin);
      }
      stepValueOrigins.push(
        ...buildValueOrigins({
          values: { ...data, Id: id },
          callerValues: input.record,
          lookups: create.notes,
          coerced: create.coerced,
          originSources,
          computedFields: Object.hasOwn(input.record, 'Id') ? [] : ['Id'],
          platformDefaults: (await services.metadataManager.getEntityMetadata(result.collection)).properties
            .filter(
              (property) => !Object.hasOwn(data, property.name) && property.defaultHint?.providedByServer
            )
            .map((property) => ({ field: property.name, observed: false })),
        }).map((origin) => ({ index, alias: input.alias, ...origin }))
      );
      dataByIndex.set(index, { ...data, Id: id });
      idsByAlias.set(input.alias, id);
      result.id = id;
      result.data = { ...data, Id: id };
      result.state = 'succeeded'; // Prepared successfully; execution state is finalized below.
    } catch (error) {
      const formatted = writeToolError(error, result.collection);
      result.state = 'failed';
      result.error = formatted.error;
      errors.push({ index, reason: formatted.error });
    }
  }

  const continueOnError = args.continue_on_error ?? false;
  const replaySteps = prepared.map((step, index) => {
    // Replay the canonical, already-coerced intent so relative values cannot
    // drift between preview and confirmation. Restore only dependency markers;
    // those are included in the confirmation fingerprint and dependency graph.
    const record = { ...(step.data ?? plan.steps[index].record) };
    for (const ref of plan.references.get(index) ?? []) {
      const canonical =
        [...canonicalFields[index]].find(([, source]) => source === ref.field)?.[0] ?? ref.field;
      record[canonical] = { $ref: ref.alias };
    }
    if (step.id) record.Id = step.id;
    return { alias: step.alias, collection: step.collection, record };
  });
  const normalizedArgs = {
    steps: replaySteps,
    ...(args.idempotency_key ? { idempotency_key: args.idempotency_key } : {}),
    idempotency_scope: scope,
    continue_on_error: continueOnError,
  };
  if (errors.length && !continueOnError) {
    for (const result of prepared) if (result.state === 'succeeded') result.state = 'not_executed';
    return {
      content: [{ type: 'text', text: 'Подготовка пакета завершилась ошибками; записи не создавались.' }],
      structuredContent: {
        collection: 'multiple',
        total: plan.steps.length,
        succeeded: 0,
        failed: errors.length,
        created: new Array(plan.steps.length).fill(null),
        first_failed_index: Math.min(...errors.map((item) => item.index)),
        dry_run: Boolean(args.dry_run),
        step_results: prepared.map(({ index, alias, collection, id, state, error }) => ({
          index,
          alias,
          collection,
          id,
          state,
          error,
        })),
        errors,
        ...(stepValueOrigins.length ? { value_origins: stepValueOrigins } : {}),
      },
      isError: true,
    };
  }

  if (args.dry_run) {
    return {
      content: [
        {
          type: 'text',
          text: errors.length
            ? 'Пакет подготовлен частично; записей не создавалось.'
            : 'Пакет подготовлен; записей не создавалось.',
        },
      ],
      structuredContent: {
        collection: 'multiple',
        total: plan.steps.length,
        succeeded: 0,
        failed: errors.length,
        created: new Array(plan.steps.length).fill(null),
        first_failed_index: errors.length ? Math.min(...errors.map((item) => item.index)) : null,
        dry_run: true,
        ready: errors.length === 0,
        normalized_args: normalizedArgs,
        ...(stepValueOrigins.length ? { value_origins: stepValueOrigins } : {}),
        step_results: prepared.map(({ index, alias, collection, id, state, error }) => ({
          index,
          alias,
          collection,
          id,
          state: state === 'succeeded' ? 'not_executed' : state,
          error,
        })),
        ...(errors.length ? { errors } : {}),
      },
      ...(errors.length ? { isError: true } : {}),
    };
  }

  const normalizedSteps = prepared.map((step, index) => ({
    alias: step.alias,
    collection: step.collection,
    record: step.data ?? plan.steps[index].record,
  }));
  const operation = {
    tool: toolName,
    collection: 'multiple',
    normalized_steps: normalizedSteps,
    dependencies: plan.steps.map((step, index) => ({
      alias: step.alias,
      references: (plan.references.get(index) ?? []).map((ref) => ({
        ...ref,
        field: [...canonicalFields[index]].find(([, source]) => source === ref.field)?.[0] ?? ref.field,
      })),
    })),
    idempotency_scope: scope,
    ...(args.idempotency_key ? { idempotency_key: args.idempotency_key } : {}),
    continue_on_error: continueOnError,
    errors,
  };
  if (args.confirm !== true)
    return confirmationResponse(
      toolName,
      [
        `План связанных записей: создание ${prepared.filter((step) => step.data).length}, ошибок подготовки ${errors.length}.`,
      ],
      {
        collection: 'multiple',
        total: plan.steps.length,
        succeeded: 0,
        failed: errors.length,
        created: new Array(plan.steps.length).fill(null),
        first_failed_index: errors.length ? Math.min(...errors.map((error) => error.index)) : null,
        step_results: prepared.map(({ index, alias, collection, id, error }) => ({
          index,
          alias,
          collection,
          id,
          state: 'not_executed',
          error,
        })),
        // Keep aliases and $ref values in the replay arguments. They are part of
        // the dependency graph bound into the confirmation fingerprint.
        normalized_args: normalizedArgs,
        ...(stepValueOrigins.length ? { value_origins: stepValueOrigins } : {}),
        confirmation_token: createConfirmationPlan(services, operation),
      }
    );
  consumeConfirmationPlan(services, args.confirmation_token, operation);

  const executionState = new Map<number, PreparedBatchStep['state']>();
  for (const index of plan.order) {
    const result = prepared[index];
    if (!result.data) continue;
    const failedDependency = result.refs.find((alias) => {
      const dependencyIndex = aliases.get(alias)!;
      const state = executionState.get(dependencyIndex);
      return state !== 'succeeded';
    });
    if (failedDependency) {
      result.state = 'not_executed';
      result.error = `Шаг пропущен: зависимость alias "${failedDependency}" не создана.`;
      executionState.set(index, result.state);
      errors.push({ index, reason: result.error });
      continue;
    }
    try {
      const outcome = await services.odataClient.createRecordWithOutcome<Record<string, unknown>>(
        result.collection,
        result.data,
        { id: result.id! }
      );
      result.id = recordId(outcome.record);
      result.state = 'succeeded';
      executionState.set(index, 'succeeded');
    } catch (error) {
      const state = writeFailureState(error);
      const formatted = writeToolError(error, result.collection);
      result.state = state;
      result.error = formatted.error;
      executionState.set(index, state);
      errors.push({ index, reason: formatted.error });
      if (!continueOnError) {
        for (const remaining of plan.order.slice(plan.order.indexOf(index) + 1)) {
          if (prepared[remaining].data) {
            prepared[remaining].state = 'not_executed';
            executionState.set(remaining, 'not_executed');
          }
        }
        break;
      }
    }
  }

  const created = prepared.map((step) => (step.state === 'succeeded' ? step.id : null));
  const succeeded = prepared.filter((step) => step.state === 'succeeded').length;
  return {
    content: [
      {
        type: 'text',
        text: errors.length
          ? `Создано ${succeeded} из ${plan.steps.length} записей; ошибки отражены по исходным индексам.`
          : `Создано ${succeeded} записей.`,
      },
    ],
    structuredContent: {
      collection: 'multiple',
      total: plan.steps.length,
      succeeded,
      failed: errors.length,
      created,
      first_failed_index: errors.length ? Math.min(...errors.map((item) => item.index)) : null,
      step_results: prepared.map(({ index, alias, collection, id, state, error }) => ({
        index,
        alias,
        collection,
        id,
        state,
        error,
      })),
      normalized_args: normalizedArgs,
      ...(stepValueOrigins.length ? { value_origins: stepValueOrigins } : {}),
      ...(errors.length ? { errors } : {}),
    },
    ...(errors.length ? { isError: true } : {}),
  };
}

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
  label: (index: number) => string,
  normalizedArgs?: Record<string, unknown>
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
      ...(normalizedArgs ? { normalized_args: normalizedArgs } : {}),
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
          collection: z.string().optional().describe('Имя коллекции (EntitySet) для режима records'),
          records: z
            .array(z.record(z.string(), z.unknown()))
            .min(1)
            .max(1000)
            .optional()
            .describe('Массив записей для создания (lookup-поля резолвятся)'),
          steps: z
            .array(
              z.object({
                alias: z.string(),
                collection: z.string(),
                record: z.record(z.string(), z.unknown()),
              })
            )
            .min(1)
            .max(1000)
            .optional()
            .describe(
              'Альтернативный режим для связанных записей. Ссылки на шаги задаются только как {"$ref":"alias"} в GUID lookup-полях.'
            ),
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
          idempotency_scope: z
            .enum(['session', 'user'])
            .optional()
            .describe(
              'user сохраняет UUID по tenant, адресу инстанса и подтверждённому пользователю BPMSoft; требует idempotency_key в режиме records.'
            ),
          dry_run: z
            .boolean()
            .optional()
            .describe('Подготовить все строки без создания или обновления записей.'),
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
          clarifications: z.array(z.record(z.string(), z.unknown())).optional(),
          dry_run: z.boolean().optional(),
          ready: z.boolean().optional(),
          normalized_args: z.record(z.string(), z.unknown()).optional(),
          source_timezone: z
            .array(
              z.object({
                index: z.number().int(),
                time_zone: z.string(),
                source: z.enum(['profile', 'environment']),
              })
            )
            .optional(),
          activity_warnings: z.array(z.string()).optional(),
          first_failed_index: z.number().int().nullable(),
          mode: modeShape.optional(),
          resolved_lookups: z.array(resolvedLookupNoteShape).optional(),
          value_origins: z
            .array(
              z.object({ index: z.number().int(), alias: z.string().optional(), ...valueOriginShape.shape })
            )
            .optional(),
          line_items_notes: lineItemsNotesShape,
          step_results: z
            .array(
              z.object({
                index: z.number().int(),
                alias: z.string(),
                collection: z.string(),
                id: z.string().nullable(),
                state: z.enum(['succeeded', 'failed', 'not_executed', 'outcome_unknown']),
                error: z.string().optional(),
              })
            )
            .optional(),
        },
        annotations: meta.annotations,
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        const plannedOps: BulkOp[] = [];
        let executionStarted = false;
        try {
          await services.authManager.ensureAuthenticated();
          if (params.steps !== undefined) {
            if (
              params.collection !== undefined ||
              params.records !== undefined ||
              params.match_on !== undefined ||
              params.if_exists !== undefined
            )
              throw new BpmApiError(
                'Передайте либо steps, либо collection вместе с records; режимы не объединяются.',
                400
              );
            return await executeBatchCreateSteps(services, meta.name, {
              steps: params.steps as BatchCreateStep[],
              continue_on_error: params.continue_on_error,
              idempotency_key: params.idempotency_key,
              idempotency_scope: params.idempotency_scope,
              dry_run: params.dry_run,
              confirm: params.confirm,
              confirmation_token: params.confirmation_token,
            });
          }
          if (params.collection === undefined || params.records === undefined)
            throw new BpmApiError('Нужны collection и records либо steps.', 400);
          const records = params.records;
          if (params.idempotency_scope === 'user' && params.idempotency_key === undefined)
            throw new BpmApiError('idempotency_scope=user в режиме records требует idempotency_key.', 400);
          const collection = await resolveCollectionName(services, params.collection);
          const total = records.length;
          validateIdempotencyKey(params.idempotency_key);
          if (total > 1000) throw new BpmApiError('Пакет ограничен 1000 элементами.', 400, collection);
          const continueOnError = params.continue_on_error ?? false;
          const entityMeta = await services.metadataManager.getEntityMetadata(collection);

          if (total === 0) {
            return {
              content: [{ type: 'text', text: 'Массив записей пуст. Нечего создавать.' }],
              isError: true,
            };
          }

          // Колонки match_on сверяются со схемой до любых запросов.
          const matchColumns: Array<{ name: string; guid: boolean }> = [];
          if (params.match_on?.length) {
            for (const raw of params.match_on) {
              const ref = await services.metadataManager.resolveFieldReference(collection, raw);
              if (ref.name === null) throw new UnknownFieldError(raw, collection, ref.suggestions);
              assertSafeIdentifier(ref.name, 'match_on');
              const prop = entityMeta.properties.find((p) => p.name === ref.name);
              matchColumns.push({ name: ref.name, guid: Boolean(prop?.type.endsWith('Guid')) });
            }
          }

          const displayColumn = (await getDisplayColumn(services.metadataManager, collection)) ?? 'Name';
          const resolved: Array<Record<string, unknown> | null> = new Array(total).fill(null);
          const resolutionDetails: Array<{
            notes: ResolvedLookupNote[];
            coerced: CoercedValueNote[];
            errors: ResolutionFieldError[];
          } | null> = new Array(total).fill(null);
          const label = (i: number): string => {
            const value = records[i]?.[displayColumn] ?? resolved[i]?.[displayColumn];
            return value == null || value === '' ? `#${i + 1}` : `#${i + 1} ${String(value)}`;
          };

          const allNotes: ResolvedLookupNote[] = [];
          const allCoerced: CoercedValueNote[] = [];
          const createValueOrigins: Array<{
            index: number;
            field: string;
            source: string;
            observed: boolean;
            value?: unknown;
          }> = [];
          const errors: ItemError[] = [];
          const lineNotes: string[] = [];
          const activityWarnings: string[] = [];
          const sourceTimezones: Array<{
            index: number;
            time_zone: string;
            source: 'profile' | 'environment';
          }> = [];
          const lineParents = new Map<number, string[]>();
          const resolutionContext = createCreateResolutionContext(services);
          for (let i = 0; i < total; i++) {
            try {
              if (collection === 'Activity') {
                if (!matchColumns.length) {
                  resolved[i] = params.records[i];
                  continue;
                }
                const matchInput: Record<string, unknown> = {};
                for (const [rawKey, value] of Object.entries(params.records[i])) {
                  const ref = await services.metadataManager.resolveFieldReference(collection, rawKey);
                  if (ref.name && matchColumns.some((column) => column.name === ref.name)) {
                    if (Object.hasOwn(matchInput, ref.name))
                      throw new BpmApiError(
                        `Поле "${ref.name}" передано несколько раз под разными именами.`,
                        400,
                        collection
                      );
                    matchInput[ref.name] = value;
                  }
                }
                const resolver = services.lookupResolver as typeof services.lookupResolver & {
                  resolveDataLookups(
                    collection: string,
                    data: Record<string, unknown>,
                    context: never,
                    options: { collectErrors: true }
                  ): Promise<{
                    data: Record<string, unknown>;
                    notes: ResolvedLookupNote[];
                    coerced: CoercedValueNote[];
                    origins: Array<{
                      field: string;
                      source: 'caller' | 'normalized' | 'lookup' | 'current_user' | 'computed';
                    }>;
                    errors: ResolutionFieldError[];
                  }>;
                };
                const r = await resolver.resolveDataLookups(collection, matchInput, resolutionContext, {
                  collectErrors: true,
                });
                resolved[i] = (r.errors ?? []).length ? null : r.data;
                resolutionDetails[i] = { notes: r.notes, coerced: r.coerced ?? [], errors: r.errors ?? [] };
                for (const fieldError of r.errors ?? []) {
                  const blocker = resolutionErrorBlocker(fieldError);
                  errors.push({ index: i, reason: blocker.message, blockers: [blocker] });
                }
                continue;
              }
              const resolver = services.lookupResolver as typeof services.lookupResolver & {
                resolveDataLookups(
                  collection: string,
                  data: Record<string, unknown>,
                  context: never,
                  options: { collectErrors: true }
                ): Promise<{
                  data: Record<string, unknown>;
                  notes: ResolvedLookupNote[];
                  coerced: CoercedValueNote[];
                  origins: Array<{
                    field: string;
                    source: 'caller' | 'normalized' | 'lookup' | 'current_user' | 'computed';
                  }>;
                  errors: ResolutionFieldError[];
                }>;
              };
              const r = await resolver.resolveDataLookups(collection, params.records[i], resolutionContext, {
                collectErrors: true,
              });
              const timezone = await detectSourceTimezone(
                services,
                collection,
                params.records[i],
                resolutionContext as never
              );
              if (timezone) sourceTimezones.push({ index: i, ...timezone });
              resolved[i] = (r.errors ?? []).length ? null : r.data;
              resolutionDetails[i] = { notes: r.notes, coerced: r.coerced ?? [], errors: r.errors ?? [] };
              allNotes.push(...r.notes);
              allCoerced.push(...(r.coerced ?? []).map((c) => ({ ...c, field: `#${i + 1} ${c.field}` })));
              for (const fieldError of r.errors ?? []) {
                const blocker = resolutionErrorBlocker(fieldError);
                errors.push({ index: i, reason: blocker.message, blockers: [blocker] });
              }
            } catch (error) {
              errors.push(preparationError(i, error, 'ошибка резолвинга lookup: '));
            }
          }

          const ifExists = params.if_exists ?? 'skip';
          const existing: Array<string | null> = new Array(total).fill(null);
          const ops: BulkOp[] = plannedOps;
          const snapshots: Record<string, unknown>[] = [];
          const collectionPath = services.odataClient.buildCollectionPath(collection);
          let ready = resolved
            .map((data, index) => (data ? { index, data } : null))
            .filter((r): r is { index: number; data: Record<string, unknown> } => r !== null);
          if (matchColumns.length) {
            const firstByKey = new Map<string, number>();
            ready = ready.filter(({ index, data }) => {
              const key = operationFingerprint(matchColumns.map((column) => norm(data[column.name])));
              const previous = firstByKey.get(key);
              if (previous !== undefined) {
                errors.push({
                  index,
                  reason: `Та же запись match_on уже передана в элементе #${previous + 1}.`,
                });
                return false;
              }
              firstByKey.set(key, index);
              return true;
            });
          }
          if (collection === 'Activity') {
            const hasFixedInterval = async (record: Record<string, unknown>) => {
              for (const [rawKey, value] of Object.entries(record)) {
                const ref = await services.metadataManager.resolveFieldReference(collection, rawKey);
                if (
                  !ref.name ||
                  !['StartDate', 'StartedOn', 'DueDate', 'EndDate', 'DueOn'].includes(ref.name)
                )
                  continue;
                if (typeof value !== 'string' || isCalendarDateOnly(value)) continue;
                if (
                  /[T ]\d{1,2}:\d{2}/.test(value) ||
                  /^(сегодня|завтра|послезавтра|today|tomorrow)\s+(?:в\s+)?\d{1,2}:\d{2}$/i.test(
                    value.trim()
                  ) ||
                  /^(сейчас|now)$/i.test(value.trim()) ||
                  /^через\s+\d{1,5}\s+(?:мин(?:ут(?:а|ы)?)?|час(?:а|ов)?)$/i.test(value.trim())
                )
                  return true;
              }
              return false;
            };
            const classified = await Promise.all(
              ready.map(async (row) => ({ ...row, fixed: await hasFixedInterval(records[row.index]) }))
            );
            ready = classified.sort((a, b) => Number(b.fixed) - Number(a.fixed) || a.index - b.index);
          }
          const matches = matchColumns.length
            ? await findExisting(services, collection, matchColumns, ready)
            : new Map<number, string[]>();
          const fallbackKey = `batch:${operationFingerprint({ collection, records, match_on: params.match_on })}`;

          for (const { index, data } of ready) {
            const ids = matches.get(index);
            if (!ids) {
              try {
                const details = resolutionDetails[index];
                const prepared =
                  collection === 'Activity'
                    ? await prepareCreateIntent(
                        services,
                        collection,
                        records[index],
                        resolutionContext as never
                      )
                    : await validateResolvedCreateData(
                        services,
                        collection,
                        data,
                        details?.notes ?? [],
                        details?.coerced ?? [],
                        details?.errors ?? []
                      );
                if (prepared.blockers.length) {
                  const missing = prepared.blockers.flatMap((blocker) => blocker.missing_fields ?? []);
                  errors.push({
                    index,
                    reason: prepared.blockers.map((blocker) => blocker.message).join(' '),
                    ...(missing.length ? { missing_fields: missing } : {}),
                    blockers: prepared.blockers,
                  });
                  continue;
                }
                createValueOrigins.push(
                  ...buildValueOrigins({
                    values: prepared.data,
                    callerValues: params.records[index],
                    lookups: prepared.notes,
                    coerced: prepared.coerced,
                    originSources: prepared.origins,
                    computedFields: Object.hasOwn(params.records[index], 'Id') ? [] : ['Id'],
                    platformDefaults: entityMeta.properties
                      .filter(
                        (property) =>
                          !Object.hasOwn(prepared.data, property.name) &&
                          property.defaultHint?.providedByServer
                      )
                      .map((property) => ({ field: property.name, observed: false })),
                  }).map((origin) => ({ index, ...origin }))
                );
                const line = prepared.line;
                const key =
                  params.idempotency_key ??
                  (ifExists === 'update' && line.data.Id === undefined ? fallbackKey : undefined);
                const id = await creationRecordIdWithScope(
                  services,
                  line.data,
                  key,
                  `${collection}:batch-create:${index}`,
                  params.idempotency_scope ?? 'session',
                  resolutionContext
                );
                if (!Object.hasOwn(params.records[index], 'Id'))
                  createValueOrigins.push({
                    index,
                    field: 'Id',
                    source: 'computed',
                    observed: true,
                    value: id,
                  });
                if (prepared.activity) reservePreparedActivity(resolutionContext as never, prepared.activity);
                ops.push({
                  index,
                  method: 'POST',
                  url: collectionPath,
                  record_id: id,
                  body: { ...line.data, Id: id },
                });
                if (prepared.activity) {
                  activityWarnings.push(
                    ...prepared.activity.warnings.map((warning) => `#${index + 1} ${warning}`)
                  );
                  if (prepared.activity.availabilityChecked)
                    activityWarnings.push(
                      `#${index + 1} Занятость проверена по снимку; интервал не блокируется атомарно и может измениться до сохранения.`
                    );
                  if (prepared.activity.timeZone)
                    sourceTimezones.push({
                      index,
                      time_zone: prepared.activity.timeZone.timeZone,
                      source: prepared.activity.timeZone.source,
                    });
                } else if (prepared.source_timezone)
                  sourceTimezones.push({ index, ...prepared.source_timezone });
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
              const updateResolved =
                collection === 'Activity'
                  ? await services.lookupResolver.resolveDataLookups(
                      collection,
                      records[index],
                      resolutionContext as never
                    )
                  : { data };
              const updateData = updateResolved.data;
              if (
                updateData.Id !== undefined &&
                String(updateData.Id).toLowerCase() !== ids[0].toLowerCase()
              ) {
                errors.push({ index, reason: 'Id передан для другой записи; UUID менять нельзя.' });
                continue;
              }
              const snapshot = await services.odataClient.getRecord<Record<string, unknown>>(
                collection,
                ids[0]
              );
              snapshots.push(snapshot);
              const patch = { ...updateData };
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

          const normalizedRows = Array.from({ length: total }, (_, index) => {
            const op = ops.find((candidate) => candidate.method === 'POST' && candidate.index === index);
            if (op) return op.body ?? records[index];
            const error = errors.find((candidate) => candidate.index === index);
            if (error) return records[index];
            return collection === 'Activity' ? records[index] : (resolved[index] ?? records[index]);
          });
          const normalizedBatchArgs: Record<string, unknown> = {
            collection,
            records: normalizedRows,
            ...(params.idempotency_key ? { idempotency_key: params.idempotency_key } : {}),
            ...(params.idempotency_scope ? { idempotency_scope: params.idempotency_scope } : {}),
            ...(params.continue_on_error !== undefined
              ? { continue_on_error: params.continue_on_error }
              : {}),
            ...(params.match_on ? { match_on: params.match_on } : {}),
            ...(params.if_exists ? { if_exists: params.if_exists } : {}),
          };
          const clarifications = errors.flatMap((item) =>
            buildClarifications(
              item.blockers ?? (item.missing_fields ? [{ missing_fields: item.missing_fields }] : []),
              'data'
            ).map((clarification) => ({
              index: item.index,
              ...clarification,
              apply_to: `normalized_args.records[${item.index}]`,
            }))
          );

          // Preparation reserves Activity intervals fixed-first, but writes retain source order.
          ops.sort((a, b) => a.index - b.index);

          if (params.dry_run) {
            const normalized = normalizedBatchArgs;
            return {
              content: [
                {
                  type: 'text',
                  text: errors.length
                    ? `Подготовка завершена с блокерами в ${errors.length} строках. Записи не изменены.`
                    : 'Подготовка пройдена. Записи не изменены.',
                },
              ],
              structuredContent: {
                collection,
                total,
                succeeded: ops.filter((op) => op.method === 'POST').length,
                failed: errors.length,
                created: new Array(total).fill(null),
                first_failed_index: errors.length ? Math.min(...errors.map((error) => error.index)) : null,
                dry_run: true,
                ready: errors.length === 0,
                normalized_args: normalized,
                ...(clarifications.length ? { clarifications } : {}),
                ...(errors.length ? { errors } : {}),
                ...(allNotes.length ? { resolved_lookups: lookupNotesStructured(allNotes) } : {}),
                ...(createValueOrigins.length ? { value_origins: createValueOrigins } : {}),
                ...(sourceTimezones.length ? { source_timezone: sourceTimezones } : {}),
                ...(activityWarnings.length ? { activity_warnings: activityWarnings } : {}),
                ...(lineNotes.length ? { line_items_notes: lineNotes } : {}),
              },
            };
          }
          if (errors.length > 0 && !continueOnError) {
            const aborted = abortedBeforeSend(
              `Пакетное создание в ${collection}`,
              errors,
              label,
              normalizedBatchArgs
            );
            if (clarifications.length && aborted.structuredContent)
              aborted.structuredContent.clarifications = clarifications;
            return aborted;
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
              normalized_args: normalizedBatchArgs,
              ...(clarifications.length ? { clarifications } : {}),
              first_failed_index: sortedErrors[0]?.index ?? null,
              ...(run.mode ? { mode: run.mode } : {}),
              ...(allNotes.length ? { resolved_lookups: lookupNotesStructured(allNotes) } : {}),
              ...(createValueOrigins.length ? { value_origins: createValueOrigins } : {}),
              ...(sourceTimezones.length ? { source_timezone: sourceTimezones } : {}),
              ...(activityWarnings.length ? { activity_warnings: activityWarnings } : {}),
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
                id: z
                  .string()
                  .optional()
                  .describe('UUID записи или её название (Name/Title) — сервер найдёт Id сам'),
                match_by: matchBySchema.optional(),
                data: z.record(z.string(), z.unknown()),
                operations: z
                  .array(
                    z.object({
                      field: z.string(),
                      op: z.enum(['add', 'increment', 'percent_change', 'shift_date', 'set_if_empty']),
                      value: z.unknown().optional(),
                      amount: z.union([z.string(), z.number()]).optional(),
                      unit: z.enum(['calendar_days', 'hours', 'minutes']).optional(),
                    })
                  )
                  .optional()
                  .describe('Относительные операции, нормализуемые по одному снимку до подтверждения.'),
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
          clarifications: z.array(z.record(z.string(), z.unknown())).optional(),
          first_failed_index: z.number().int().nullable(),
          normalized_args: z.record(z.string(), z.unknown()).optional(),
          safe_retry_indices: z
            .array(z.number().int())
            .optional()
            .describe('Исходные индексы; retry_args.updates идут в том же порядке.'),
          retry_args: z.record(z.string(), z.unknown()).optional(),
          no_changes: z.array(z.number().int()).optional(),
          source_timezone: z
            .array(
              z.object({
                index: z.number().int(),
                time_zone: z.string(),
                source: z.enum(['profile', 'environment']),
              })
            )
            .optional(),
          mode: modeShape.optional(),
          resolved_lookups: z.array(resolvedLookupNoteShape).optional(),
          matched_by: z.array(z.object({ index: z.number().int(), ...matchedByShape.shape })).optional(),
          value_origins: z.array(z.object({ index: z.number().int(), ...valueOriginShape.shape })).optional(),
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
          const matchedBy: Array<{
            index: number;
            fields: Array<{ field: string; caption: string; type: string }>;
            values: Record<string, unknown>;
          }> = [];
          const label = (i: number): string => `#${i + 1} (${params.updates[i]?.id})`;
          const ops: BulkOp[] = plannedOps;
          const snapshots: Record<string, unknown>[] = [];
          const errors: ItemError[] = [];
          const allNotes: ResolvedLookupNote[] = [];
          const allCoerced: CoercedValueNote[] = [];
          const valueOrigins: Array<{
            index: number;
            field: string;
            source: 'caller' | 'normalized' | 'lookup' | 'current_user' | 'computed' | 'platform_default';
            observed: boolean;
            value?: unknown;
          }> = [];
          const lineNotes: string[] = [];
          const sourceTimezones: Array<{
            index: number;
            time_zone: string;
            source: 'profile' | 'environment';
          }> = [];
          const noChanges: number[] = [];
          const lineParents = new Map<number, string[]>();
          const updateContext = createCreateResolutionContext(services);
          for (let i = 0; i < total; i++) {
            const update = params.updates[i];
            try {
              const ref = await resolveRecordTarget(services, collection, update);
              ids[i] = ref.id;
              if (ref.matched_by) matchedBy.push({ index: i, ...ref.matched_by });
              if (ref.matched !== undefined) matchedNotes.push(`«${update.id}» → ${ref.matched} (${ref.id})`);
            } catch (error) {
              errors.push({ index: i, reason: `запись не найдена: ${errorOf(error)}` });
              continue;
            }
            try {
              const snapshot = await services.odataClient.getRecord<Record<string, unknown>>(
                collection,
                ids[i]!
              );
              snapshots.push(snapshot);
              if (update.expected_etag !== undefined && params.confirm !== true)
                await services.odataClient.assertExpectedEtag(collection, ids[i]!, update.expected_etag);
              const preparedUpdate = await prepareUpdateIntent(
                services,
                collection,
                ids[i]!,
                update.data ?? {},
                (update.operations ?? []) as UpdateOperation[],
                snapshot,
                updateContext
              );
              if (preparedUpdate.blockers.length) {
                errors.push({
                  index: i,
                  reason: preparedUpdate.blockers.map((blocker) => blocker.message).join(' '),
                  ...(preparedUpdate.blockers.flatMap((blocker) => blocker.missing_fields ?? []).length
                    ? {
                        missing_fields: preparedUpdate.blockers.flatMap(
                          (blocker) => blocker.missing_fields ?? []
                        ),
                      }
                    : {}),
                  blockers: preparedUpdate.blockers,
                });
                continue;
              }
              allNotes.push(...preparedUpdate.notes);
              allCoerced.push(
                ...preparedUpdate.coerced.map((note) => ({ ...note, field: `#${i + 1} ${note.field}` }))
              );
              valueOrigins.push(
                ...buildValueOrigins({
                  values: preparedUpdate.data,
                  callerValues: update.data,
                  lookups: preparedUpdate.notes,
                  coerced: preparedUpdate.coerced,
                  originSources: preparedUpdate.origins,
                  computedFields: (update.operations ?? []).map((operation) => operation.field),
                }).map((origin) => ({ index: i, ...origin }))
              );
              if (preparedUpdate.source_timezone)
                sourceTimezones.push({ index: i, ...preparedUpdate.source_timezone });
              if (preparedUpdate.no_changes) {
                noChanges.push(i);
                continue;
              }
              const line = await enrichLineItem(services, collection, preparedUpdate.data, {
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
          const normalizedUpdates = Array.from({ length: total }, (_, index) => {
            const op = ops.find((candidate) => candidate.index === index);
            if (op)
              return {
                ...(params.updates[index]?.match_by
                  ? { match_by: params.updates[index].match_by }
                  : { id: op.record_id }),
                data: op.body ?? {},
                ...(params.updates[index]?.expected_etag
                  ? { expected_etag: params.updates[index].expected_etag }
                  : {}),
              };
            const source = params.updates[index];
            return {
              ...(source.match_by ? { match_by: source.match_by } : { id: ids[index] ?? source.id }),
              data: source.data ?? {},
              ...(source.operations?.length ? { operations: source.operations } : {}),
              ...(source.expected_etag ? { expected_etag: source.expected_etag } : {}),
            };
          });
          if (ops.length === 0 && params.confirm !== true) {
            const normalizedArgs = {
              collection,
              updates: normalizedUpdates,
              continue_on_error: continueOnError,
            };
            return {
              content: [
                {
                  type: 'text',
                  text: errors.length
                    ? 'Пакет не содержит изменений; для части строк есть ошибки.'
                    : 'Изменений нет; записей не обновляли.',
                },
              ],
              isError: errors.length > 0,
              structuredContent: {
                collection,
                total,
                succeeded: noChanges.length,
                failed: errors.length,
                ids,
                no_changes: noChanges,
                ...(valueOrigins.length ? { value_origins: valueOrigins } : {}),
                normalized_args: normalizedArgs,
                ...(errors.length ? { errors: [...errors].sort((a, b) => a.index - b.index) } : {}),
                first_failed_index: errors.length ? Math.min(...errors.map((error) => error.index)) : null,
              },
            };
          }
          const operation = {
            tool: meta.name,
            collection,
            updates: normalizedUpdates,
            continue_on_error: continueOnError,
            snapshots,
            ops,
            no_changes: noChanges,
            errors,
          };
          const normalizedIntent = {
            tool: meta.name,
            collection,
            updates: normalizedUpdates,
            continue_on_error: continueOnError,
          };
          const originalIntent = {
            tool: meta.name,
            collection,
            updates: params.updates.map((update) => ({
              ...(update.match_by ? { match_by: update.match_by } : { id: update.id }),
              ...(update.data !== undefined ? { data: update.data } : {}),
              ...(update.operations?.length ? { operations: update.operations } : {}),
              ...(update.expected_etag ? { expected_etag: update.expected_etag } : {}),
            })),
            continue_on_error: continueOnError,
          };
          const freshness = {
            intent: originalIntent,
            acceptedIntents: [normalizedIntent],
            snapshots: ids.flatMap((id, index) => {
              if (!id) return [];
              const snapshot = snapshots.find((record) => recordId(record) === id);
              if (!snapshot) return [];
              return {
                index,
                id,
                values: Object.fromEntries(
                  Object.entries(snapshot).filter(([field]) => !field.startsWith('@odata.'))
                ),
              };
            }),
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
                ...(matchedBy.length ? { matched_by: matchedBy } : {}),
                normalized_args: {
                  collection,
                  updates: normalizedUpdates,
                  continue_on_error: continueOnError,
                },
                no_changes: noChanges,
                records: previewRecordSummary(snapshots),
                concurrency_protection: concurrencyProtection(snapshots),
                confirmation_token: createConfirmationPlan(services, operation, freshness),
                changes: await Promise.all(
                  ops.map(async (op) => {
                    const snapshot = snapshots.find((record) => recordId(record) === op.record_id) ?? {};
                    const diff = await previewWriteChanges(services, collection, snapshot, op.body ?? {});
                    return {
                      index: op.index,
                      id: op.record_id,
                      fields: await previewWriteFields(services, collection, op.body!),
                      changes: diff.changes,
                    };
                  })
                ),
              }
            );
          const stale = consumeConfirmationPlan(services, params.confirmation_token, operation, freshness);
          if (stale) {
            const changed = stale.changed.map((row) => ({
              index: row.index,
              id: row.id,
              fields: row.fields,
            }));
            return confirmationResponse(
              meta.name,
              [
                'Снимок изменился после предварительного просмотра. Записи не изменены. Проверьте обновлённый план:',
              ],
              {
                collection,
                total,
                succeeded: 0,
                failed: errors.length,
                first_failed_index: errors[0]?.index ?? null,
                ids,
                ...(matchedBy.length ? { matched_by: matchedBy } : {}),
                normalized_args: {
                  collection,
                  updates: normalizedUpdates,
                  continue_on_error: continueOnError,
                },
                no_changes: noChanges,
                records: previewRecordSummary(snapshots),
                concurrency_protection: concurrencyProtection(snapshots),
                conflict: { changed },
                changes: await Promise.all(
                  ops.map(async (op) => {
                    const snapshot = snapshots.find((record) => recordId(record) === op.record_id) ?? {};
                    const diff = await previewWriteChanges(services, collection, snapshot, op.body ?? {});
                    return {
                      index: op.index,
                      id: op.record_id,
                      fields: await previewWriteFields(services, collection, op.body!),
                      changes: diff.changes,
                    };
                  })
                ),
                confirmation_token: createConfirmationPlan(services, operation, freshness),
              }
            );
          }

          if (ops.length === 0) {
            return {
              content: [{ type: 'text', text: 'Изменений нет; записей не обновляли.' }],
              structuredContent: {
                collection,
                total,
                succeeded: noChanges.length,
                failed: errors.length,
                ids,
                ...(matchedBy.length ? { matched_by: matchedBy } : {}),
                no_changes: noChanges,
              },
            };
          }

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
              `  Не выполнено (остановлено на первой ошибке): ${run.notRun.map((i) => `#${i + 1}`).join(', ')} — используйте готовые retry_args для нового превью и подтверждения.`
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
          const safeRetryIndices = run.outcomes
            .filter((outcome) => outcome.state === 'not_executed')
            .map((outcome) => outcome.index)
            .sort((a, b) => a - b);
          const clarifications = errors.flatMap((item) =>
            buildClarifications(
              item.blockers ?? (item.missing_fields ? [{ missing_fields: item.missing_fields }] : []),
              'data'
            ).map((clarification) => ({
              index: item.index,
              ...clarification,
              apply_to: `normalized_args.updates[${item.index}]`,
            }))
          );
          const resultChanges = await Promise.all(
            ops.map(async (op) => {
              const snapshot = snapshots.find((record) => recordId(record) === op.record_id) ?? {};
              const outcome = run.outcomes.find((item) => item.index === op.index);
              const response =
                outcome?.body && typeof outcome.body === 'object'
                  ? (outcome.body as Record<string, unknown>)
                  : undefined;
              const responseCoversPatch = Boolean(
                outcome?.state === 'succeeded' &&
                response &&
                Object.keys(op.body ?? {}).every((field) => Object.hasOwn(response, field))
              );
              const requestedPatch = op.body ?? {};
              const displayedPatch = responseCoversPatch
                ? Object.fromEntries(Object.keys(requestedPatch).map((field) => [field, response![field]]))
                : requestedPatch;
              const diff = await previewWriteChanges(services, collection, snapshot, displayedPatch);
              return {
                index: op.index,
                id: op.record_id,
                state: outcome?.state,
                basis: responseCoversPatch ? 'observed_response' : 'requested',
                changes: diff.changes,
              };
            })
          );
          const verificationArgs = run.outcomes
            .filter((outcome) => outcome.state === 'outcome_unknown')
            .flatMap((outcome) => {
              const expected = normalizedUpdates[outcome.index]?.data;
              return expected && Object.keys(expected).length
                ? [
                    {
                      index: outcome.index,
                      collection,
                      id: outcome.record_id,
                      verify: { operation: 'update' as const, expected },
                    },
                  ]
                : [];
            });
          return {
            content: [{ type: 'text', text: lines.join('\n') }],
            isError: errors.length > 0,
            structuredContent: {
              collection,
              total,
              succeeded: run.ok.size,
              outcomes: run.outcomes,
              changes: resultChanges,
              ...(verificationArgs.length ? { verification_args: verificationArgs } : {}),
              operation_ids: ops.map((op) => op.record_id),
              failed: errors.length,
              ids,
              ...(matchedBy.length ? { matched_by: matchedBy } : {}),
              normalized_args: {
                collection,
                updates: normalizedUpdates,
                continue_on_error: continueOnError,
              },
              ...(safeRetryIndices.length
                ? {
                    safe_retry_indices: safeRetryIndices,
                    retry_args: {
                      collection,
                      updates: safeRetryIndices.map((index) => normalizedUpdates[index]),
                      continue_on_error: continueOnError,
                    },
                  }
                : {}),
              no_changes: noChanges,
              ...(errors.length ? { errors: sortedErrors } : {}),
              ...(clarifications.length ? { clarifications } : {}),
              first_failed_index: sortedErrors[0]?.index ?? null,
              ...(run.mode ? { mode: run.mode } : {}),
              ...(allNotes.length ? { resolved_lookups: lookupNotesStructured(allNotes) } : {}),
              ...(valueOrigins.length ? { value_origins: valueOrigins } : {}),
              ...(sourceTimezones.length ? { source_timezone: sourceTimezones } : {}),
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
          const freshness = {
            intent: { tool: meta.name, collection, ids: params.ids, continue_on_error: continueOnError },
            snapshots: snapshots.map((snapshot, index) => ({
              index: found[index]?.index ?? index,
              id: recordId(snapshot),
              values: Object.fromEntries(
                Object.entries(snapshot).filter(([field]) => !field.startsWith('@odata.'))
              ),
            })),
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
                confirmation_token: createConfirmationPlan(services, operation, freshness),
                ...(errors.length ? { errors } : {}),
              }
            );
          }
          const stale = consumeConfirmationPlan(services, params.confirmation_token, operation, freshness);
          if (stale) {
            return confirmationResponse(
              meta.name,
              [
                'Снимок изменился после предварительного просмотра. Записи не удалены; проверьте обновлённый план.',
              ],
              {
                collection,
                ids: found.map((it) => it.id),
                count: found.length,
                items: found,
                records: previewRecordSummary(snapshots),
                conflict: { changed: stale.changed },
                concurrency_protection: concurrencyProtection(snapshots),
                ...(errors.length ? { errors } : {}),
                confirmation_token: createConfirmationPlan(services, operation, freshness),
              }
            );
          }

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
