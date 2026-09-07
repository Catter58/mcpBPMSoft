/**
 * OData query helpers — escaping and validation.
 *
 * Used by lookup-resolver, metadata-manager and write-by-filter tools to
 * prevent OData injection through field/collection names interpolated into
 * $filter expressions or URL paths.
 */

import { BpmApiError } from './errors.js';
import { isTolowerSupported } from './server-capabilities.js';

const SAFE_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SAFE_PATH_RE = /^[A-Za-z_][A-Za-z0-9_/]*$/;
const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isSafeIdentifier(name: string): boolean {
  return typeof name === 'string' && SAFE_IDENT_RE.test(name);
}

/** A path may include `/` for navigation (Account/Name etc.). */
export function isSafePath(name: string): boolean {
  return typeof name === 'string' && SAFE_PATH_RE.test(name);
}

export function assertSafeIdentifier(name: string, label = 'identifier'): void {
  if (!isSafeIdentifier(name)) {
    throw new BpmApiError(
      `Недопустимое значение для ${label}: "${name}". Разрешены только латинские буквы, цифры и подчёркивания, начало — с буквы или подчёркивания.`,
      400,
      undefined,
      undefined,
      undefined,
      undefined,
      'unsafe_identifier'
    );
  }
}

export function isGuid(value: string): boolean {
  return typeof value === 'string' && GUID_RE.test(value);
}

export function assertGuid(id: string, label = 'id'): void {
  if (!isGuid(id)) {
    throw new Error(
      `Недопустимое значение для ${label}: "${id}". Ожидается канонический GUID (например, 11111111-2222-3333-4444-555555555555).`
    );
  }
}

/**
 * GUID-литерал для $filter: v3 требует `guid'...'`, v4 — голый UUID.
 * Валидирует значение, поэтому результат безопасно подставлять в выражение.
 */
export function guidLiteral(id: string, odataVersion: 3 | 4): string {
  assertGuid(id);
  return odataVersion === 3 ? `guid'${id}'` : id;
}

export function assertSafePath(name: string, label = 'path'): void {
  if (!isSafePath(name)) {
    throw new Error(
      `Недопустимый путь для ${label}: "${name}". Разрешены латинские буквы, цифры, подчёркивания и "/".`
    );
  }
}

/**
 * Escape an OData v4 string literal: doubles single quotes and strips
 * control characters that cannot appear inside a string literal.
 */
export function escapeODataString(value: string): string {
  return value.replace(/'/g, "''").replace(/\n/g, '').replace(/\r/g, '').replace(/\t/g, ' ');
}

/**
 * Builds a substring-match expression valid for the given OData version:
 * v4 — contains(field, 'v'); v3 — substringof('v', field).
 *
 * С caseInsensitive поле оборачивается в tolower(), а значение приводится к
 * нижнему регистру здесь же — иначе на инстансе без tolower() (латч в
 * server-capabilities) в фильтр уходило бы искажённое значение.
 */
export function containsExpression(
  fieldPath: string,
  value: string,
  odataVersion: 3 | 4,
  opts: { caseInsensitive?: boolean } = {}
): string {
  // Регистронезависимость запрашивается вызывающим, но последнее слово за
  // инстансом: если tolower() уже уронил запрос, больше его не строим.
  const caseInsensitive = opts.caseInsensitive === true && isTolowerSupported();
  const literal = `'${escapeODataString(caseInsensitive ? value.toLowerCase() : value)}'`;
  const field = caseInsensitive ? `tolower(${fieldPath})` : fieldPath;
  return odataVersion === 3 ? `substringof(${literal}, ${field})` : `contains(${field}, ${literal})`;
}
