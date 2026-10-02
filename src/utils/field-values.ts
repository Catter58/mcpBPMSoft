/** Metadata-owned scalar validation shared by search filters and writes. */
import type { EntityProperty, ODataVersion } from '../types/index.js';
import { BpmApiError } from './errors.js';
import { escapeODataString } from './odata.js';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function fieldValueError(property: EntityProperty, message: string, collection?: string): BpmApiError {
  return new BpmApiError(
    `Поле "${property.caption || property.name}" (${property.name}, ${property.type}): ${message}`,
    400,
    collection
  );
}

export function isDateType(type: string): boolean {
  return ['Edm.Date', 'Edm.DateTime', 'Edm.DateTimeOffset'].includes(type);
}

export function isNumericType(type: string): boolean {
  return [
    'Edm.Byte',
    'Edm.SByte',
    'Edm.Int16',
    'Edm.Int32',
    'Edm.Int64',
    'Edm.Single',
    'Edm.Double',
    'Edm.Decimal',
  ].includes(type);
}

export function coerceFieldValue(
  value: unknown,
  property: EntityProperty,
  collection?: string,
  options: { allowNull?: boolean } = {}
): string | number | boolean | null {
  const fail = (message: string): never => {
    throw fieldValueError(property, message, collection);
  };
  if (value === undefined) return fail('значение не задано.');
  if (value === null) {
    if (!property.nullable && !options.allowNull) return fail('поле не допускает null.');
    return null;
  }
  switch (property.type) {
    case 'Edm.String':
      return typeof value === 'string' ? value : fail('ожидается строка.');
    case 'Edm.Guid':
      return typeof value === 'string' && UUID_RE.test(value.trim())
        ? value.trim().toLowerCase()
        : fail('ожидается UUID.');
    case 'Edm.Boolean':
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string' && /^(true|false)$/i.test(value.trim()))
        return value.trim().toLowerCase() === 'true';
      return fail('ожидается true или false.');
    case 'Edm.Byte':
    case 'Edm.SByte':
    case 'Edm.Int16':
    case 'Edm.Int32':
    case 'Edm.Int64': {
      if (typeof value !== 'number' && typeof value !== 'string') return fail('ожидается целое число.');
      if (typeof value === 'number' && !Number.isSafeInteger(value))
        return fail('целое число должно быть точным; большие значения передавайте строкой.');
      const text = String(value).trim();
      if (!/^[+-]?\d+$/.test(text)) return fail('ожидается целое число.');
      const integer = BigInt(text);
      const ranges: Record<string, [bigint, bigint]> = {
        'Edm.Byte': [0n, 255n],
        'Edm.SByte': [-128n, 127n],
        'Edm.Int16': [-32768n, 32767n],
        'Edm.Int32': [-2147483648n, 2147483647n],
        'Edm.Int64': [-9223372036854775808n, 9223372036854775807n],
      };
      const [min, max] = ranges[property.type];
      if (integer < min || integer > max) return fail('число выходит за допустимый диапазон.');
      return property.type === 'Edm.Int64' ? integer.toString() : Number(integer);
    }
    case 'Edm.Single':
    case 'Edm.Double':
    case 'Edm.Decimal': {
      if (typeof value !== 'number' && typeof value !== 'string') return fail('ожидается число.');
      if (
        property.type === 'Edm.Decimal' &&
        typeof value === 'number' &&
        Number.isInteger(value) &&
        !Number.isSafeInteger(value)
      )
        return fail('большое десятичное число передавайте строкой, чтобы сохранить точность.');
      const text = String(value).trim();
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text) || !Number.isFinite(Number(text)))
        return fail('ожидается конечное число.');
      // Preserve decimal strings rather than silently round monetary values.
      return property.type === 'Edm.Decimal' ? text : Number(text);
    }
    case 'Edm.Date':
    case 'Edm.DateTime':
    case 'Edm.DateTimeOffset': {
      if (!(value instanceof Date) && typeof value !== 'string') return fail('ожидается дата в ISO 8601.');
      const text =
        value instanceof Date ? (Number.isNaN(value.getTime()) ? '' : value.toISOString()) : value.trim();
      const match =
        /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.exec(text);
      if (!match) return fail('ожидается ISO-дата YYYY-MM-DD или дата и время с часовым поясом.');
      const clock = /T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(text);
      if (clock && (+clock[1] > 23 || +clock[2] > 59 || +(clock[3] ?? 0) > 59))
        return fail('некорректное время.');
      const calendar = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
      if (Number.isNaN(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== text.slice(0, 10))
        return fail('дата не существует.');
      const parsed = new Date(text);
      if (Number.isNaN(parsed.getTime())) return fail('некорректное время или часовой пояс.');
      if (property.type === 'Edm.Date') {
        if (text.length !== 10) return fail('ожидается дата YYYY-MM-DD без времени.');
        return text;
      }
      return parsed.toISOString();
    }
    case 'Edm.Binary':
      return typeof value === 'string' &&
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
        ? value
        : fail('ожидается строка base64.');
    default:
      return fail('тип поля не поддерживает скалярную запись или сравнение.');
  }
}

export function literalizeFieldValue(
  value: unknown,
  property: EntityProperty,
  version: ODataVersion,
  collection?: string
): string {
  const typed = coerceFieldValue(value, property, collection, { allowNull: true });
  if (typed === null) return 'null';
  if (property.type === 'Edm.Guid') return version === 3 ? `guid'${typed}'` : String(typed);
  if (isNumericType(property.type) || property.type === 'Edm.Boolean' || property.type === 'Edm.Date')
    return String(typed);
  if (isDateType(property.type)) {
    const iso = String(typed).replace(/\.000Z$/, 'Z');
    if (version === 3)
      return `${property.type === 'Edm.DateTimeOffset' ? 'datetimeoffset' : 'datetime'}'${property.type === 'Edm.DateTime' ? iso.replace(/Z$/, '') : iso}'`;
    return iso;
  }
  return `'${escapeODataString(String(typed))}'`;
}
