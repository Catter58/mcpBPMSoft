import { createHash, randomUUID } from 'node:crypto';
import type { ServiceContainer } from '../tools/init-tool.js';
import { BpmApiError, LookupResolutionError, formatToolError } from './errors.js';
import { operationScope } from './confirm.js';
import { assertGuid } from './odata.js';

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

/** Designer required flags are independent of EDM nullable and platform defaults. */
export async function validateRequiredCreateFields(
  services: ServiceContainer,
  collection: string,
  data: Record<string, unknown>
): Promise<void> {
  const metadata = await services.metadataManager.getEntityMetadata(collection);
  const missing = metadata.properties
    .filter((property) => {
      if (property.name === 'Id' || property.required !== true) return false;
      const supplied = Object.hasOwn(data, property.name);
      if (!supplied) return property.defaultHint?.providedByServer !== true;
      const value = data[property.name];
      return (
        value === undefined ||
        value === null ||
        (typeof value === 'string' && !value.trim()) ||
        (property.type === 'Edm.Guid' &&
          typeof value === 'string' &&
          /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value))
      );
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
