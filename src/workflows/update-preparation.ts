import * as z from 'zod';
import type { ServiceContainer } from '../tools/init-tool.js';
import type { ResolutionContext } from '../lookup/resolution-context.js';
import type { ResolvedLookupNote } from '../lookup/lookup-resolver.js';
import type { EntityProperty } from '../types/index.js';
import { BpmApiError, LookupResolutionError, formatToolError } from '../utils/errors.js';
import { decimal, addDecimal, multiplyDecimal, divideDecimal, decimalText } from '../utils/decimal.js';
import { isValidTimeZone, zonedParts } from '../utils/datetime.js';
import { localToUtc } from '../utils/coerce.js';
import { createCreateResolutionContext } from './create-preparation.js';
import { classifyRequiredCreateField } from '../utils/write-safety.js';
import type { CoercedValueNote } from '../utils/coerce.js';

export type UpdateOperation = {
  field: string;
  op: 'add' | 'increment' | 'percent_change' | 'shift_date' | 'set_if_empty';
  value?: unknown;
  amount?: string | number;
  unit?: 'calendar_days' | 'hours' | 'minutes';
};

export const updateOperationSchema = z.discriminatedUnion('op', [
  z
    .object({
      field: z.string().min(1),
      op: z.literal('add'),
      amount: z.union([z.string().max(1000), z.number().finite()]),
    })
    .strict(),
  z
    .object({
      field: z.string().min(1),
      op: z.literal('increment'),
      amount: z.union([z.string().max(1000), z.number().finite()]),
    })
    .strict(),
  z
    .object({
      field: z.string().min(1),
      op: z.literal('percent_change'),
      amount: z.union([z.string().max(1000), z.number().finite()]),
    })
    .strict(),
  z
    .object({
      field: z.string().min(1),
      op: z.literal('shift_date'),
      amount: z.number().finite(),
      unit: z.enum(['calendar_days', 'hours', 'minutes']),
    })
    .strict(),
  z.object({ field: z.string().min(1), op: z.literal('set_if_empty'), value: z.unknown() }).strict(),
]);

export interface PreparedUpdateIntent {
  data: Record<string, unknown>;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  notes: ResolvedLookupNote[];
  coerced: CoercedValueNote[];
  origins: Array<{ field: string; source: 'caller' | 'normalized' | 'lookup' | 'current_user' }>;
  snapshot: Record<string, unknown>;
  concurrency_protection: 'etag' | 'snapshot_only';
  source_timezone?: { time_zone: string; source: 'profile' | 'environment' };
  blockers: Array<{
    code: string;
    message: string;
    field?: string;
    caption?: string;
    argument_path?: 'data' | 'operations';
    operation?: UpdateOperation['op'];
    missing_fields?: Array<{ name: string; caption: string; type: string }>;
  }>;
  no_changes?: boolean;
}

function isNumericType(type: string): boolean {
  return [
    'Edm.Decimal',
    'Edm.Double',
    'Edm.Single',
    'Edm.Int16',
    'Edm.Int32',
    'Edm.Int64',
    'Edm.Byte',
    'Edm.SByte',
  ].includes(type);
}

function valuesMatchSnapshot(next: unknown, current: unknown, property: EntityProperty): boolean {
  if (Object.is(next, current)) return true;
  if (
    isNumericType(property.type) &&
    (typeof next === 'string' || typeof next === 'number') &&
    (typeof current === 'string' || typeof current === 'number')
  ) {
    try {
      return decimalText(decimal(next)) === decimalText(decimal(current));
    } catch {
      return false;
    }
  }
  return false;
}

function applyNumeric(
  op: UpdateOperation,
  current: unknown,
  prop: EntityProperty,
  collection: string
): string | number {
  if (current === null || current === undefined || current === '')
    throw new BpmApiError(
      `Операция ${op.op} требует существующее числовое значение поля ${op.field}.`,
      400,
      collection
    );
  if (!isNumericType(prop.type) || (typeof current !== 'string' && typeof current !== 'number'))
    throw new BpmApiError(
      `Операция ${op.op} требует числовое поле с числовым текущим значением (${op.field}).`,
      400,
      collection
    );
  const amountValue = op.amount;
  if (typeof amountValue !== 'string' && typeof amountValue !== 'number')
    throw new BpmApiError(`Для операции ${op.op} укажите числовое amount.`, 400, collection);
  try {
    const base = decimal(current);
    const amount = decimal(amountValue);
    const result =
      op.op === 'percent_change'
        ? addDecimal(
            base,
            divideDecimal(multiplyDecimal(base, amount), decimal(100), base.scale + amount.scale + 2)
          )
        : addDecimal(base, amount);
    if (prop.type.startsWith('Edm.Int') || ['Edm.Byte', 'Edm.SByte'].includes(prop.type)) {
      if (result.scale > 0 && result.units % 10n ** BigInt(result.scale) !== 0n)
        throw new BpmApiError(
          `Операция ${op.op} дала дробное значение для целочисленного поля ${op.field}.`,
          400,
          collection
        );
      const text = decimalText(result);
      return prop.type === 'Edm.Int64' ? text : Number(text);
    }
    const text = decimalText(result);
    return prop.type === 'Edm.Decimal' ? text : Number(text);
  } catch (error) {
    if (error instanceof BpmApiError) throw error;
    throw new BpmApiError(`Некорректное числовое значение для поля ${op.field}.`, 400, collection);
  }
}

async function shiftedDate(
  op: UpdateOperation,
  current: unknown,
  prop: EntityProperty,
  context: ResolutionContext,
  collection: string
): Promise<string> {
  if (!['Edm.Date', 'Edm.DateTime', 'Edm.DateTimeOffset'].includes(prop.type))
    throw new BpmApiError(
      `Операция shift_date поддерживается только для полей дат и времени (${op.field}).`,
      400,
      collection
    );
  if (current === null || current === undefined || current === '')
    throw new BpmApiError(
      `Операция shift_date требует существующую дату в поле ${op.field}.`,
      400,
      collection
    );
  if (typeof current !== 'string' || !Number.isFinite(Date.parse(current)))
    throw new BpmApiError(`Поле ${op.field} должно содержать дату-время для сдвига.`, 400, collection);
  const amount = op.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount))
    throw new BpmApiError('Для shift_date укажите конечное числовое amount.', 400, collection);
  const unit = op.unit;
  if (!unit)
    throw new BpmApiError(
      'Для shift_date явно укажите unit: calendar_days, hours или minutes.',
      400,
      collection
    );
  const instant = new Date(current);
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(
      current
    );
  if (!match) throw new BpmApiError(`Поле ${op.field} должно содержать дату в ISO-8601.`, 400, collection);
  const calendarDate = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (
    calendarDate.getUTCFullYear() !== Number(match[1]) ||
    calendarDate.getUTCMonth() + 1 !== Number(match[2]) ||
    calendarDate.getUTCDate() !== Number(match[3])
  )
    throw new BpmApiError(`Поле ${op.field} содержит некорректную календарную дату.`, 400, collection);
  if (prop.type === 'Edm.Date') {
    if (unit !== 'calendar_days' || !Number.isInteger(amount))
      throw new BpmApiError('Для Edm.Date задайте целый сдвиг calendar_days.', 400, collection);
    const shifted = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + amount));
    if (shifted.getUTCFullYear() < 1 || shifted.getUTCFullYear() > 9999)
      throw new BpmApiError('Сдвиг даты выходит за допустимый диапазон.', 400, collection);
    return shifted.toISOString().slice(0, 10);
  }
  if (unit === 'calendar_days' && !Number.isInteger(amount))
    throw new BpmApiError('Сдвиг calendar_days должен быть целым числом.', 400, collection);
  if (unit === 'hours' || unit === 'minutes') {
    const ms = amount * (unit === 'hours' ? 3600000 : 60000);
    const shiftedMs = instant.getTime() + ms;
    if (!Number.isFinite(ms) || !Number.isFinite(shiftedMs) || Math.abs(shiftedMs) > 8.64e15)
      throw new BpmApiError('Сдвиг даты выходит за допустимый диапазон.', 400, collection);
    return new Date(shiftedMs).toISOString();
  }
  let zone: string;
  try {
    zone = (await context.getTimeZone()).timeZone;
  } catch {
    throw new BpmApiError(
      'Для calendar_days необходим корректный часовой пояс профиля или окружения.',
      400,
      collection
    );
  }
  if (!isValidTimeZone(zone))
    throw new BpmApiError('Часовой пояс для calendar_days некорректен.', 400, collection);
  const parts = zonedParts(instant, zone);
  const wallClock = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
      .formatToParts(instant)
      .map((part) => [part.type, part.value])
  );
  const seconds = Number(wallClock.second);
  const milliseconds = instant.getUTCMilliseconds();
  const day = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + amount));
  const shifted = localToUtc(
    day.getUTCFullYear(),
    day.getUTCMonth() + 1,
    day.getUTCDate(),
    parts.hour,
    parts.minute,
    seconds,
    zone,
    milliseconds
  );
  if (!shifted)
    throw new BpmApiError(
      'Локальное время после календарного сдвига не существует или неоднозначно из-за перехода часового пояса; изменение заблокировано.',
      400,
      collection
    );
  return shifted;
}

/** Prepare an absolute update patch. Relative operations are evaluated once against a supplied or fetched snapshot. */
export async function prepareUpdateIntent(
  services: ServiceContainer,
  collection: string,
  id: string,
  input: Record<string, unknown>,
  operations: UpdateOperation[] = [],
  snapshot?: Record<string, unknown>,
  context: ResolutionContext = createCreateResolutionContext(services)
): Promise<PreparedUpdateIntent> {
  const current = snapshot ?? (await services.odataClient.getRecord<Record<string, unknown>>(collection, id));
  const metadata = await services.metadataManager.getEntityMetadata(collection);
  const canonicalData: Record<string, unknown> = {};
  const props = new Map(metadata.properties.map((prop) => [prop.name, prop]));
  const sources = new Map<string, string>();
  const blockers: PreparedUpdateIntent['blockers'] = [];
  const operationModes = new Map<string, UpdateOperation['op']>();
  const block = (
    error: unknown,
    field?: string,
    argumentPath: 'data' | 'operations' = 'data',
    operation?: UpdateOperation['op']
  ) => {
    const formatted = formatToolError(error, collection);
    blockers.push({
      code: formatted.code,
      message: formatted.error,
      ...(field ? { field, argument_path: argumentPath } : {}),
      ...(operation ? { operation } : {}),
    });
  };
  if (operations.length > 100)
    block(new BpmApiError('За один вызов можно передать не более 100 операций.', 400, collection));
  for (const [key, value] of Object.entries(input)) {
    try {
      const field = await services.metadataManager.resolveFieldReference(collection, key);
      if (!field.name || !props.has(field.name))
        throw new BpmApiError(`Поле ${key} не найдено.`, 400, collection);
      if (field.name === 'Id' || metadata.keyFields?.includes(field.name))
        throw new BpmApiError('UUID записи нельзя менять. Передайте его через id.', 400, collection);
      if (sources.has(field.name))
        throw new BpmApiError(`Поле ${field.name} передано несколько раз.`, 400, collection);
      sources.set(field.name, key);
      canonicalData[field.name] = value;
    } catch (error) {
      block(error, key);
    }
  }
  const absolute = { ...canonicalData };
  const seenOps = new Set<string>();
  let calendarTimeZoneNeeded = false;
  for (const operation of operations) {
    try {
      const field = await services.metadataManager.resolveFieldReference(collection, operation.field);
      if (!field.name || !props.has(field.name))
        throw new BpmApiError(`Поле ${operation.field} не найдено.`, 400, collection);
      if (field.name === 'Id' || metadata.keyFields?.includes(field.name))
        throw new BpmApiError('UUID записи нельзя менять.', 400, collection);
      if (sources.has(field.name) || seenOps.has(field.name))
        throw new BpmApiError(
          `Поле ${field.name} задано одновременно или повторно в data/operations.`,
          400,
          collection
        );
      seenOps.add(field.name);
      operationModes.set(field.name, operation.op);
      const prop = props.get(field.name)!;
      if (operation.op === 'shift_date' && operation.unit === 'calendar_days' && prop.type !== 'Edm.Date')
        calendarTimeZoneNeeded = true;
      const before = current[field.name];
      if (operation.op === 'set_if_empty') {
        if (
          before !== null &&
          before !== undefined &&
          before !== '' &&
          !(
            prop.type === 'Edm.Guid' &&
            typeof before === 'string' &&
            /^0{8}-0{4}-0{4}-0{4}-0{12}$/i.test(before)
          )
        )
          continue;
        if (!Object.hasOwn(operation, 'value'))
          throw new BpmApiError('Для set_if_empty укажите value.', 400, collection);
        absolute[field.name] = operation.value;
      } else if (
        operation.op === 'add' ||
        operation.op === 'increment' ||
        operation.op === 'percent_change'
      ) {
        absolute[field.name] = applyNumeric(operation, before, prop, collection);
      } else absolute[field.name] = await shiftedDate(operation, before, prop, context, collection);
    } catch (error) {
      block(error, operation.field, 'operations', operation.op);
    }
  }
  const noChanges = Object.keys(absolute).length === 0 && blockers.length === 0 && operations.length > 0;
  if (!Object.keys(absolute).length && !noChanges && blockers.length === 0)
    block(new BpmApiError('Не переданы поля для обновления.', 400, collection));
  for (const field of Object.keys(absolute)) {
    const property = props.get(field)!;
    if (classifyRequiredCreateField(property, absolute) === 'missing') {
      blockers.push({
        code: 'missing_required_fields',
        message: `Обязательное поле ${property.caption ?? field} (${field}) не может быть пустым.`,
        field,
        missing_fields: [{ name: field, caption: property.caption ?? field, type: property.type }],
      });
    }
  }
  const resolved = await services.lookupResolver.resolveDataLookups(collection, absolute, context, {
    collectErrors: true,
  });
  for (const error of resolved.errors ?? []) {
    const formatted = formatToolError(error.error, collection);
    const lookup = error.error instanceof LookupResolutionError ? error.error : undefined;
    blockers.push({
      code: formatted.code,
      message: formatted.error,
      field: error.canonicalField ?? error.rawKey,
      argument_path: operationModes.has(error.canonicalField ?? error.rawKey) ? 'operations' : 'data',
      ...(operationModes.has(error.canonicalField ?? error.rawKey)
        ? { operation: operationModes.get(error.canonicalField ?? error.rawKey) }
        : {}),
      ...(props.get(error.canonicalField ?? error.rawKey)?.caption
        ? { caption: props.get(error.canonicalField ?? error.rawKey)!.caption }
        : {}),
      ...(lookup
        ? {
            candidates: lookup.candidates,
            lookup_collection: lookup.context.lookupCollection,
            ...(lookup.context.validValues ? { valid_values: lookup.context.validValues } : {}),
          }
        : {}),
    });
  }
  const after = { ...current, ...resolved.data };
  const alreadyApplied =
    Object.keys(resolved.data).length > 0 &&
    Object.entries(resolved.data).every(([field, value]) => {
      const property = props.get(field);
      return property
        ? valuesMatchSnapshot(value, current[field], property)
        : Object.is(value, current[field]);
    });
  const before = Object.fromEntries(Object.keys(resolved.data).map((field) => [field, current[field]]));
  let sourceTimezone: PreparedUpdateIntent['source_timezone'];
  if (calendarTimeZoneNeeded) {
    try {
      const zone = await context.getTimeZone();
      sourceTimezone = { time_zone: zone.timeZone, source: zone.source };
    } catch {
      if (!blockers.length)
        block(
          new BpmApiError(
            'Для calendar_days необходим корректный часовой пояс профиля или окружения.',
            400,
            collection
          )
        );
    }
  }
  return {
    data: resolved.data,
    before,
    after: Object.fromEntries(Object.keys(resolved.data).map((field) => [field, after[field]])),
    notes: resolved.notes,
    coerced: resolved.coerced ?? [],
    origins: resolved.origins ?? [],
    snapshot: current,
    concurrency_protection: current['@odata.etag'] ? 'etag' : 'snapshot_only',
    ...(sourceTimezone ? { source_timezone: sourceTimezone } : {}),
    blockers,
    ...(noChanges || (alreadyApplied && blockers.length === 0) ? { no_changes: true } : {}),
  };
}
