import { createHash, randomUUID } from 'node:crypto';
import type { ServiceContainer } from '../tools/init-tool.js';
import { BpmApiError, LookupResolutionError, formatToolError } from './errors.js';
import { operationScope } from './confirm.js';
import { assertGuid, isGuid } from './odata.js';
import { compareDecimal, decimal } from './decimal.js';
import { coerceFieldValue } from './field-values.js';
import { getRequestAuth, hasRequestAuth } from '../auth/request-context.js';
import type { ResolutionContext } from '../lookup/resolution-context.js';
import { presentRecords } from '../read/record-presentation.js';
import { isMeMacro } from './me-macro.js';
import type { ResolvedLookupNote } from '../lookup/lookup-resolver.js';
import type { CoercedValueNote } from './coerce.js';

export type ValueOriginSource =
  | 'caller'
  | 'normalized'
  | 'lookup'
  | 'current_user'
  | 'computed'
  | 'platform_default';
export interface ValueOrigin {
  field: string;
  source: ValueOriginSource;
  observed: boolean;
  value?: unknown;
}

/** Explain how each write value was obtained without claiming unseen server defaults as observed values. */
export function buildValueOrigins(args: {
  values: Record<string, unknown>;
  callerValues?: Record<string, unknown>;
  lookups?: ResolvedLookupNote[];
  coerced?: CoercedValueNote[];
  computedFields?: string[];
  platformDefaults?: Array<{ field: string; value?: unknown; observed: boolean }>;
  originSources?: Array<{
    field: string;
    source: 'caller' | 'normalized' | 'lookup' | 'current_user' | 'computed';
  }>;
}): ValueOrigin[] {
  const lookupFields = new Set((args.lookups ?? []).map((note) => note.field));
  const coercedFields = new Set((args.coerced ?? []).map((note) => note.field));
  const computedFields = new Set(args.computedFields ?? []);
  const sources = new Map((args.originSources ?? []).map((origin) => [origin.field, origin.source]));
  const origins: ValueOrigin[] = Object.entries(args.values).map(([field, value]) => {
    const original = args.callerValues?.[field];
    const source: ValueOriginSource = computedFields.has(field)
      ? 'computed'
      : (sources.get(field) ??
        (typeof original === 'string' && isMeMacro(original)
          ? 'current_user'
          : lookupFields.has(field)
            ? 'lookup'
            : coercedFields.has(field)
              ? 'normalized'
              : 'caller'));
    return { field, source, observed: true, value };
  });
  for (const item of args.platformDefaults ?? []) {
    if (item.observed || !Object.hasOwn(args.values, item.field)) {
      const origin: ValueOrigin = {
        field: item.field,
        source: 'platform_default',
        observed: item.observed,
        ...(item.observed ? { value: item.value } : {}),
      };
      const existing = origins.findIndex((entry) => entry.field === item.field);
      if (existing >= 0) origins[existing] = origin;
      else origins.push(origin);
    }
  }
  return origins;
}

export type IdempotencyScope = 'session' | 'user';

export type WriteState = 'succeeded' | 'failed' | 'not_executed' | 'outcome_unknown';
export interface WriteOutcome {
  id: string;
  state: WriteState;
  error?: string;
}

export interface MissingCreateField {
  name: string;
  caption: string;
  type: string;
}

export class MissingRequiredFieldsError extends BpmApiError {
  constructor(
    collection: string,
    public readonly missingFields: MissingCreateField[]
  ) {
    super(
      `Заполните обязательные поля: ${missingFields.map((field) => `${field.caption} (${field.name})`).join(', ')}. Ничего не создано.`,
      400,
      collection,
      undefined,
      undefined,
      [
        'Повторите создание, заполнив missing_fields. Не подставляйте случайные значения.',
        `Уточните типы и справочники через bpm_get_schema(${collection}); пользователь должен определить отсутствующие значения.`,
      ]
    );
  }

  override toToolError() {
    return { ...super.toToolError(), missing_fields: this.missingFields };
  }
}

/** Shared interpretation of whether a required create field needs caller input. */
export function classifyRequiredCreateField(
  property: {
    name: string;
    type: string;
    required?: boolean;
    defaultHint?: { source?: string; providedByServer?: boolean; value?: unknown };
  },
  data: Record<string, unknown>
): 'not_required' | 'provided_by_server' | 'provided_by_caller' | 'missing' {
  if (property.name === 'Id' || property.required !== true) return 'not_required';
  if (Object.hasOwn(data, property.name)) {
    const value = data[property.name];
    const empty =
      value === undefined ||
      value === null ||
      (typeof value === 'string' && !value.trim()) ||
      (property.type === 'Edm.Guid' &&
        typeof value === 'string' &&
        /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value));
    return empty ? 'missing' : 'provided_by_caller';
  }
  const hint = property.defaultHint;
  if (hint?.providedByServer === true) {
    if (hint.source === 'runtime' || hint.source === 'system_setting') return 'provided_by_server';
    if (hint.source !== 'constant' || hint.value === null || hint.value === undefined) return 'missing';
    if (typeof hint.value === 'string' && !hint.value.trim()) return 'missing';
    if (
      property.type === 'Edm.Guid' &&
      typeof hint.value === 'string' &&
      /^0{8}-0{4}-0{4}-0{4}-0{12}$/i.test(hint.value)
    )
      return 'missing';
    try {
      coerceFieldValue(hint.value, {
        name: property.name,
        type: property.type,
        nullable: false,
        isLookup: false,
      });
    } catch {
      return 'missing';
    }
    return 'provided_by_server';
  }
  return 'missing';
}

/** Designer required flags are independent of EDM nullable and platform defaults. */
export async function validateRequiredCreateFields(
  services: ServiceContainer,
  collection: string,
  data: Record<string, unknown>
): Promise<void> {
  const metadata = await services.metadataManager.getEntityMetadata(collection);
  const missing = metadata.properties
    .filter((property) => {
      return classifyRequiredCreateField(property, data) === 'missing';
    })
    .map((property) => ({
      name: property.name,
      caption: property.caption ?? property.name,
      type: property.type,
    }));
  if (missing.length) throw new MissingRequiredFieldsError(collection, missing);
}

/** A caller key addresses one durable CRM record, including across server restarts. */
export function operationRecordId(services: ServiceContainer, key?: string, step = 'record'): string {
  validateIdempotencyKey(key);
  if (!key) return randomUUID();
  const bytes = createHash('sha256')
    .update(`${operationScope(services)}:${step}:${key}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function validateIdempotencyKey(key: unknown): void {
  if (key !== undefined && (typeof key !== 'string' || !key.trim() || key.length > 200)) {
    throw new BpmApiError('idempotency_key должен быть непустой строкой длиной до 200 символов.', 400);
  }
}

export function creationRecordId(
  services: ServiceContainer,
  data: Record<string, unknown>,
  key?: string,
  step = 'record'
): string {
  validateIdempotencyKey(key);
  const keyedId = key === undefined ? undefined : operationRecordId(services, key, step);
  if (data.Id !== undefined) {
    if (typeof data.Id !== 'string') throw new BpmApiError('Id должен быть UUID.', 400);
    assertGuid(data.Id, 'Id');
    if (keyedId && data.Id.toLowerCase() !== keyedId.toLowerCase())
      throw new BpmApiError(
        'Id в данных конфликтует с idempotency_key. Передайте один способ задания UUID.',
        400
      );
    return data.Id;
  }
  return keyedId ?? operationRecordId(services);
}

/**
 * Resolve an idempotency scope for creation workflows. The default session
 * scope deliberately preserves existing IDs. User scope is opt-in and is
 * derived only from the validated request tenant and BPMSoft's current-user
 * macro, never from configured credentials or an unverified username.
 */
export async function creationRecordIdWithScope(
  services: ServiceContainer,
  data: Record<string, unknown>,
  key?: string,
  step = 'record',
  scope: IdempotencyScope = 'session',
  context?: ResolutionContext
): Promise<string> {
  if (scope === 'session') return creationRecordId(services, data, key, step);
  if (scope !== 'user') throw new BpmApiError('idempotency_scope должен быть session или user.', 400);
  validateIdempotencyKey(key);

  // Explicit IDs without a key do not rely on an idempotency scope.
  if (key === undefined && data.Id !== undefined) return creationRecordId(services, data, key, step);
  if (key === undefined) throw new BpmApiError('idempotency_scope=user требует idempotency_key.', 400);

  const id = await operationRecordIdWithScope(services, key, step, scope, context);
  if (data.Id !== undefined) {
    if (typeof data.Id !== 'string') throw new BpmApiError('Id должен быть UUID.', 400);
    assertGuid(data.Id, 'Id');
    if (data.Id.toLowerCase() !== id.toLowerCase())
      throw new BpmApiError(
        'Id в данных конфликтует с idempotency_key. Передайте один способ задания UUID.',
        400
      );
    return data.Id;
  }
  return id;
}

/** Stable creation identity shared by fresh processes for one verified user. */
export async function operationRecordIdWithScope(
  services: ServiceContainer,
  key?: string,
  step = 'record',
  scope: IdempotencyScope = 'session',
  context?: ResolutionContext
): Promise<string> {
  validateIdempotencyKey(key);
  if (scope === 'session') return operationRecordId(services, key, step);
  if (scope !== 'user') throw new BpmApiError('idempotency_scope должен быть session или user.', 400);
  if (!key) throw new BpmApiError('idempotency_scope=user требует idempotency_key.', 400);

  const auth = getRequestAuth();
  const tenantId = auth?.tenantId?.trim();
  if (auth && hasRequestAuth(auth) && !tenantId)
    throw new BpmApiError('Для idempotency_scope=user не подтверждён tenant запроса.', 401);
  const tenantNamespace = tenantId ? `tenant:${tenantId}` : 'stdio';

  let origin: URL;
  try {
    origin = new URL(services.config?.bpmsoft_url ?? '');
  } catch {
    throw new BpmApiError('Для idempotency_scope=user не подтверждён адрес BPMSoft.', 400);
  }
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  )
    throw new BpmApiError('Для idempotency_scope=user адрес BPMSoft некорректен.', 400);
  const canonicalOrigin = `${origin.protocol.toLowerCase()}//${origin.host.toLowerCase()}${origin.pathname.replace(/\/+$/, '')}`;

  let userId: string;
  try {
    userId = (await (context?.getCurrentUser() ?? services.currentUser.get())).userId;
  } catch {
    throw new BpmApiError('Не удалось подтвердить пользователя BPMSoft для стабильного ключа.', 401);
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId) ||
    /^0{8}-0{4}-0{4}-0{4}-0{12}$/i.test(userId)
  )
    throw new BpmApiError('BPMSoft не вернул подтверждённый UUID пользователя.', 401);

  const bytes = createHash('sha256')
    .update(`user-v1:${canonicalOrigin}:${tenantNamespace}:${userId.toLowerCase()}:${step}:${key}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function writeToolError(error: unknown, collection?: string) {
  const result = formatToolError(error, collection);
  return error instanceof LookupResolutionError
    ? {
        ...result,
        field: error.field,
        input: error.searchValue,
        candidates: error.candidates,
        lookup_collection: error.context.lookupCollection,
        valid_values: error.context.validValues,
      }
    : result;
}

export function previewRecordSummary(records: Record<string, unknown>[]) {
  return records.map((record) => {
    const id = recordId(record);
    const display = record.Name ?? record.Title ?? record.Number ?? record.Caption ?? record.Subject ?? id;
    return { id, display_value: String(display) };
  });
}

export function concurrencyProtection(records: Record<string, unknown>[]): 'etag' | 'snapshot_only' {
  return records.every((record) => recordEtag(record) !== undefined) ? 'etag' : 'snapshot_only';
}

export async function previewWriteFields(
  services: ServiceContainer,
  collection: string,
  data: Record<string, unknown>
) {
  const metadata = await services.metadataManager.getEntityMetadata(collection);
  return Object.entries(data).map(([field, value]) => ({
    field,
    caption: metadata.properties.find((property) => property.name === field)?.caption ?? field,
    value,
  }));
}

/** Human-readable, metadata-captioned diff for the fields a write will touch. */
export async function previewWriteChanges(
  services: ServiceContainer,
  collection: string,
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown>
): Promise<{ changes: Array<Record<string, unknown>>; warnings: string[] }> {
  const fields = Object.keys(after).filter((field) => field !== 'Id' && !field.startsWith('@'));
  if (!fields.length) return { changes: [], warnings: [] };
  const beforeRecord = Object.fromEntries(
    fields.filter((field) => before && field in before).map((field) => [field, before![field]])
  );
  const afterRecord = Object.fromEntries(fields.map((field) => [field, after[field]]));
  let presentation: Awaited<ReturnType<typeof presentRecords>> | undefined;
  let properties = new Map<string, { type: string; isLookup?: boolean }>();
  const warnings: string[] = [];
  try {
    presentation = await presentRecords(services, collection, [beforeRecord, afterRecord], true);
    const metadata = await services.metadataManager.getEntityMetadata(collection);
    properties = new Map(metadata.properties.map((property) => [property.name, property]));
  } catch (error) {
    void error;
    warnings.push(
      'Подписи и отображаемые значения полей недоступны; показаны технические имена и исходные значения.'
    );
  }
  const beforeDisplay = presentation?.displayRecords[0] ?? beforeRecord;
  const afterDisplay = presentation?.displayRecords[1] ?? afterRecord;
  const fieldLabels = presentation?.fieldLabels ?? {};
  const changes = fields.map((field) => {
    const label = fieldLabels[field] ?? field;
    const hasBefore = Object.prototype.hasOwnProperty.call(beforeRecord, field);
    const beforeValue = beforeDisplay[label];
    const afterValue = afterDisplay[label];
    const beforeRaw = beforeRecord[field];
    const afterRaw = afterRecord[field];
    const property = properties.get(field);
    const unchanged = property
      ? valuesEqualForPreview(property.type, beforeRaw, afterRaw)
      : JSON.stringify(beforeRaw) === JSON.stringify(afterRaw);
    const disambiguateLookup =
      property?.isLookup &&
      typeof beforeRaw === 'string' &&
      typeof afterRaw === 'string' &&
      isGuid(beforeRaw) &&
      isGuid(afterRaw) &&
      beforeRaw.toLowerCase() !== afterRaw.toLowerCase() &&
      String(beforeValue) === String(afterValue);
    return {
      field,
      caption: label,
      change: !hasBefore ? 'set' : unchanged ? 'unchanged' : 'changed',
      ...(hasBefore
        ? { before: disambiguateLookup ? `${String(beforeValue)} (${beforeRaw})` : beforeValue }
        : {}),
      after: disambiguateLookup ? `${String(afterValue)} (${afterRaw})` : afterValue,
    };
  });
  return { changes, warnings: [...warnings, ...(presentation?.warnings ?? [])] };
}

function valuesEqualForPreview(type: string | undefined, left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || left === undefined || right === null || right === undefined) return false;
  if (type === 'Edm.Guid' && typeof left === 'string' && typeof right === 'string')
    return left.toLowerCase() === right.toLowerCase();
  if (
    type &&
    [
      'Edm.Decimal',
      'Edm.Double',
      'Edm.Single',
      'Edm.Int16',
      'Edm.Int32',
      'Edm.Int64',
      'Edm.Byte',
      'Edm.SByte',
    ].includes(type)
  ) {
    try {
      return compareDecimal(decimal(String(left)), decimal(String(right))) === 0;
    } catch {
      return false;
    }
  }
  if (
    type &&
    (type === 'Edm.DateTime' || type === 'Edm.DateTimeOffset') &&
    typeof left === 'string' &&
    typeof right === 'string'
  ) {
    const valid = (value: string) => {
      const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/i.exec(
        value
      );
      if (!match) return false;
      const date = new Date(`${match[1]}T00:00:00.000Z`);
      return (
        date.toISOString().slice(0, 10) === match[1] &&
        Number(match[2]) <= 23 &&
        Number(match[3]) <= 59 &&
        Number(match[4]) <= 59 &&
        Number.isFinite(Date.parse(value))
      );
    };
    const a = Date.parse(left);
    const b = Date.parse(right);
    if (valid(left) && valid(right) && Number.isFinite(a) && Number.isFinite(b)) return a === b;
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

export function writeChangesText(changes: Array<Record<string, unknown>>): string | undefined {
  const changed = changes.filter((change) => change.change !== 'unchanged');
  if (!changed.length) return undefined;
  return [
    'Изменения:',
    ...changed.map((change) => {
      const before = Object.hasOwn(change, 'before') ? String(change.before ?? '∅') : '∅';
      return `  ${String(change.caption ?? change.field)}: ${before} → ${String(change.after ?? '∅')}`;
    }),
  ].join('\n');
}

export function buildClarifications(
  blockers: readonly unknown[] | undefined,
  argumentPath: 'data' | 'operations' | 'steps' = 'data'
): Array<Record<string, unknown>> {
  if (!blockers?.length) return [];
  const result: Array<Record<string, unknown>> = [];
  for (const rawBlocker of blockers) {
    if (!rawBlocker || typeof rawBlocker !== 'object') continue;
    const blocker = rawBlocker as Record<string, unknown>;
    const field = typeof blocker.field === 'string' ? blocker.field : undefined;
    const missing = Array.isArray(blocker.missing_fields) ? blocker.missing_fields : [];
    const fields = field
      ? [field]
      : missing.flatMap((item) =>
          item && typeof item === 'object' && typeof (item as Record<string, unknown>).name === 'string'
            ? [(item as Record<string, unknown>).name as string]
            : []
        );
    for (const name of [...new Set(fields)]) {
      // Prepared update intents are absolute; patch normalized data even when
      // the original blocker came from a relative operation.
      const patchPath = argumentPath === 'steps' ? 'steps' : 'data';
      const missingField = missing.find(
        (item) => item && typeof item === 'object' && (item as Record<string, unknown>).name === name
      ) as Record<string, unknown> | undefined;
      const choices: Array<Record<string, unknown>> = [];
      const operationCanBePatched = argumentPath !== 'operations' || blocker.operation === 'set_if_empty';
      if (operationCanBePatched && Array.isArray(blocker.valid_values)) {
        for (const value of blocker.valid_values) {
          if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
            choices.push({
              label: String(value),
              value,
              argument_patch: partialPatch(patchPath, name, value),
            });
        }
      }
      if (operationCanBePatched && Array.isArray(blocker.candidates)) {
        for (const candidate of blocker.candidates) {
          if (!candidate || typeof candidate !== 'object') continue;
          const item = candidate as Record<string, unknown>;
          if (typeof item.id === 'string' && typeof (item.displayValue ?? item.display_value) === 'string') {
            const value = item.id;
            const collection =
              typeof blocker.lookup_collection === 'string' ? blocker.lookup_collection : undefined;
            const display = String(item.displayValue ?? item.display_value);
            choices.push({
              label: `${display}${collection ? ` (${collection})` : ''} — ${value}`,
              value,
              argument_patch: partialPatch(patchPath, name, value),
            });
          }
        }
      }
      result.push({
        field: name,
        apply_to: argumentPath === 'steps' ? 'steps[index]' : 'normalized_args',
        ...(typeof missingField?.caption === 'string'
          ? { caption: missingField.caption }
          : typeof blocker.caption === 'string'
            ? { caption: blocker.caption }
            : {}),
        question: choices.length
          ? `Какое значение выбрать для поля ${String(missingField?.caption ?? blocker.caption ?? name)}?`
          : `Какое значение указать для поля ${String(missingField?.caption ?? blocker.caption ?? name)}?`,
        ...(choices.length ? { choices } : {}),
      });
    }
  }
  return result;
}

function partialPatch(
  path: 'data' | 'operations' | 'steps',
  field: string,
  value: unknown
): Record<string, unknown> {
  if (path === 'operations') return { data: { [field]: value } };
  if (path === 'steps') return { record: { [field]: value } };
  return { data: { [field]: value } };
}

export function recordId(record: Record<string, unknown>): string {
  const id = record.Id ?? record.id;
  if (typeof id !== 'string')
    throw new BpmApiError('Сервер не вернул UUID записи. Результат операции требует проверки.', 502);
  assertGuid(id, 'record.Id');
  return id;
}

export function recordEtag(record: Record<string, unknown>): string | undefined {
  const etag = record['@odata.etag'] ?? (record.__metadata as Record<string, unknown> | undefined)?.etag;
  return typeof etag === 'string' ? etag : undefined;
}

export function writeFailureState(error: unknown): WriteState {
  const formatted = formatToolError(error);
  return formatted.code === 'outcome_unknown' ||
    formatted.code === 'network' ||
    (error instanceof BpmApiError && error.httpStatus >= 500)
    ? 'outcome_unknown'
    : 'failed';
}

/** Materialize enough pages to prove the expected count, without unbounded reads. */
export async function selectExactRecords(
  services: ServiceContainer,
  collection: string,
  filter: string,
  expectedCount: number
): Promise<Record<string, unknown>[]> {
  if (!filter.trim() || !Number.isInteger(expectedCount) || expectedCount < 1 || expectedCount > 1000) {
    throw new BpmApiError('Нужны непустой filter и expected_count от 1 до 1000.', 400, collection);
  }
  const response = await services.odataClient.getRecords<Record<string, unknown>>(
    collection,
    { $filter: filter, $top: expectedCount + 1, $orderby: 'Id', $count: true },
    true,
    expectedCount + 1
  );
  const next = response['@odata.nextLink'] ?? (response as unknown as { __next?: string }).__next;
  const records = response.value;
  const knownCount = response['@odata.count'];
  const ids = records.map(recordId);
  if (
    records.length !== expectedCount ||
    next ||
    new Set(ids).size !== ids.length ||
    (knownCount !== undefined && knownCount !== expectedCount)
  ) {
    throw new BpmApiError(
      `Состав операции не подтверждён: получено ${records.length}${next ? ' и есть продолжение' : ''}, ожидалось ${expectedCount}${knownCount !== undefined ? `, сервер сообщил total_count=${knownCount}` : ''}. Ничего не изменено.`,
      400,
      collection
    );
  }
  return records.sort((a, b) => recordId(a).localeCompare(recordId(b)));
}

/** Stop on first uncertain/failed write; never blindly repeat completed steps. */
export async function executeSequentialWrites(
  records: Record<string, unknown>[],
  write: (id: string, etag?: string) => Promise<void>
): Promise<WriteOutcome[]> {
  const outcomes: WriteOutcome[] = [];
  let stopped = false;
  for (const record of records) {
    const id = recordId(record);
    if (stopped) {
      outcomes.push({ id, state: 'not_executed' });
      continue;
    }
    try {
      await write(id, recordEtag(record));
      outcomes.push({ id, state: 'succeeded' });
    } catch (error) {
      outcomes.push({
        id,
        state: writeFailureState(error),
        error: error instanceof Error ? error.message : String(error),
      });
      stopped = true;
    }
  }
  return outcomes;
}
