/**
 * OData query helpers — escaping and validation.
 *
 * Used by lookup-resolver, metadata-manager and write-by-filter tools to
 * prevent OData injection through field/collection names interpolated into
 * $filter expressions or URL paths.
 */

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
    throw new Error(
      `Недопустимое значение для ${label}: "${name}". Разрешены только латинские буквы, цифры и подчёркивания, начало — с буквы или подчёркивания.`
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
  return value
    .replace(/'/g, "''")
    .replace(/\n/g, '')
    .replace(/\r/g, '')
    .replace(/\t/g, ' ');
}

/**
 * Builds a substring-match expression valid for the given OData version:
 * v4 — contains(field, 'v'); v3 — substringof('v', field).
 * With caseInsensitive the field is wrapped in tolower(); pass the value
 * already lower-cased (e.g. NormalizedName.normalized / .core).
 */
export function containsExpression(
  fieldPath: string,
  value: string,
  odataVersion: 3 | 4,
  opts: { caseInsensitive?: boolean } = {}
): string {
  const literal = `'${escapeODataString(value)}'`;
  const field = opts.caseInsensitive ? `tolower(${fieldPath})` : fieldPath;
  return odataVersion === 3 ? `substringof(${literal}, ${field})` : `contains(${field}, ${literal})`;
}
