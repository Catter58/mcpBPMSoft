import type { ServiceContainer } from '../tools/init-tool.js';
import { BpmApiError } from '../utils/errors.js';
import { assertGuid } from '../utils/odata.js';
import { compareDecimal, decimal } from '../utils/decimal.js';

export type RecordVerificationRequest = {
  operation: 'create' | 'update' | 'delete';
  expected?: Record<string, unknown>;
};

export type RecordVerificationResult = {
  operation: RecordVerificationRequest['operation'];
  observation: 'matches' | 'differs' | 'absent' | 'unavailable';
  safe_to_retry: false;
  observed_at: string;
  differences?: Array<{ field: string; expected: unknown; actual: unknown; actual_present: boolean }>;
  reason?: string;
};

const MAX_FIELDS = 50;
const MAX_EXPECTED_BYTES = 16 * 1024;

function isNotFound(error: unknown): boolean {
  return error instanceof BpmApiError && error.httpStatus === 404;
}

function validDateOnly(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validDateTime(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/i.exec(value);
  const offset = /([+-])(\d{2}):?(\d{2})$/.exec(value);
  return Boolean(
    match &&
    validDateOnly(match[1]) &&
    Number(match[2]) <= 23 &&
    Number(match[3]) <= 59 &&
    Number(match[4]) <= 59 &&
    (!offset || (Number(offset[2]) <= 23 && Number(offset[3]) <= 59)) &&
    Number.isFinite(Date.parse(value))
  );
}

function expectedTypeSupported(type: string, value: unknown): boolean {
  if (type === 'Edm.Guid') {
    if (value === null) return true;
    if (typeof value !== 'string') return false;
    try {
      assertGuid(value, 'expected');
      return true;
    } catch {
      return false;
    }
  }
  if (type === 'Edm.String') return value === null || typeof value === 'string';
  if (
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
    if (value === null) return true;
    if (typeof value !== 'string' && typeof value !== 'number') return false;
    try {
      decimal(value);
      return true;
    } catch {
      return false;
    }
  }
  if (type === 'Edm.Boolean')
    return value === null || [true, false, 'true', 'false', 1, 0, '1', '0'].includes(value as never);
  if (type === 'Edm.Date') return value === null || validDateOnly(value);
  if (type === 'Edm.DateTime' || type === 'Edm.DateTimeOffset') return value === null || validDateTime(value);
  return false;
}

function equivalent(type: string, expected: unknown, actual: unknown): boolean | undefined {
  if (expected === null || actual === null) return expected === actual;
  if (type === 'Edm.Guid' || type === 'Edm.String') {
    if (typeof expected !== 'string' || typeof actual !== 'string') return false;
    return type === 'Edm.Guid' ? expected.toLowerCase() === actual.toLowerCase() : expected === actual;
  }
  if (
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
    if (
      (typeof expected !== 'string' && typeof expected !== 'number') ||
      (typeof actual !== 'string' && typeof actual !== 'number')
    )
      return false;
    try {
      return compareDecimal(decimal(expected), decimal(actual)) === 0;
    } catch {
      return false;
    }
  }
  if (type === 'Edm.Boolean') {
    const bool = (value: unknown): boolean | undefined =>
      value === true || value === 'true' || value === 1 || value === '1'
        ? true
        : value === false || value === 'false' || value === 0 || value === '0'
          ? false
          : undefined;
    const left = bool(expected);
    const right = bool(actual);
    return left === undefined || right === undefined ? false : left === right;
  }
  if (type.startsWith('Edm.Date')) {
    if (type === 'Edm.Date') return validDateOnly(expected) && validDateOnly(actual) && expected === actual;
    if (!validDateTime(expected) || !validDateTime(actual)) return false;
    const left = Date.parse(expected);
    const right = Date.parse(actual);
    return Number.isFinite(left) && Number.isFinite(right) ? left === right : false;
  }
  return undefined;
}

/** Read-only observation of one exact record after an uncertain write. It never retries or claims causality. */
export async function verifyRecordState(
  services: ServiceContainer,
  collection: string,
  id: string,
  request: RecordVerificationRequest
): Promise<RecordVerificationResult> {
  const base = {
    operation: request.operation,
    safe_to_retry: false as const,
    observed_at: new Date().toISOString(),
  };
  let targetReadStarted = false;
  try {
    assertGuid(id, 'id');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(collection)) throw new Error('Invalid collection identifier');
    if (request.operation !== 'delete') {
      const expected = request.expected ?? {};
      if (!expected || Array.isArray(expected) || typeof expected !== 'object')
        throw new Error('Expected values must be an object');
      if (!Object.keys(expected).length) throw new Error('No expected fields were provided');
      if (
        Object.keys(expected).length > MAX_FIELDS ||
        Buffer.byteLength(JSON.stringify(expected), 'utf8') > MAX_EXPECTED_BYTES
      )
        throw new Error('Expected field set exceeds verification limits');
      const metadata = await services.metadataManager.getEntityMetadata(collection);
      const properties = new Map(metadata.properties.map((property) => [property.name, property]));
      const fields = Object.keys(expected);
      for (const field of fields) {
        const property = properties.get(field);
        if (!property || field === 'Id' || ['Edm.Binary', 'Edm.Stream'].includes(property.type))
          throw new Error(`Field ${field} is not eligible for verification`);
        if (!expectedTypeSupported(property.type, expected[field]))
          throw new Error(`Expected value for ${field} does not match a supported ${property.type} value`);
      }
      targetReadStarted = true;
      const record = await services.odataClient.getRecord<Record<string, unknown>>(collection, id, {
        $select: ['Id', ...fields].join(','),
      });
      type Difference = NonNullable<RecordVerificationResult['differences']>[number];
      const missing: Difference[] = fields
        .filter((field) => !Object.prototype.hasOwnProperty.call(record, field))
        .map((field) => ({ field, expected: expected[field], actual: null, actual_present: false }));
      if (missing.length)
        return {
          ...base,
          observation: 'unavailable',
          differences: missing,
          reason: 'The read response did not include every requested field.',
        };
      const unsupportedActual = fields.find(
        (field) => !expectedTypeSupported(properties.get(field)!.type, record[field])
      );
      if (unsupportedActual)
        return {
          ...base,
          observation: 'unavailable',
          reason: `The read value for ${unsupportedActual} cannot be compared safely.`,
        };
      const differences: Difference[] = fields.flatMap((field) => {
        const actual = record[field];
        return equivalent(properties.get(field)!.type, expected[field], actual) === true
          ? []
          : [{ field, expected: expected[field], actual, actual_present: true }];
      });
      return {
        ...base,
        observation: differences.length ? 'differs' : 'matches',
        ...(differences.length ? { differences } : {}),
      };
    }

    targetReadStarted = true;
    await services.odataClient.getRecord<Record<string, unknown>>(collection, id, { $select: 'Id' });
    return { ...base, observation: 'differs', reason: 'The record currently exists.' };
  } catch (error) {
    if (targetReadStarted && isNotFound(error)) return { ...base, observation: 'absent' };
    return {
      ...base,
      observation: 'unavailable',
      reason: error instanceof Error ? error.message : 'The current state could not be read.',
    };
  }
}
