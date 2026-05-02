/**
 * Opaque pagination cursor.
 *
 * Encodes the request shape (collection + filter + select + ... + skip)
 * as base64url(JSON), so the LLM can pass `cursor` back to bpm_get_records /
 * bpm_search_records without parsing OData URLs.
 *
 * Versioned (`v: 1`) to allow forward-compatible changes.
 *
 * The cursor MUST round-trip cleanly with `decodeCursor(encodeCursor(state)) === state`
 * (modulo undefined-stripping).
 */

export interface CursorState {
  v: 1;
  collection: string;
  filter?: string;
  select?: string;
  orderby?: string;
  expand?: string;
  count?: boolean;
  top?: number;
  skip: number;
  /** Optional: search criteria DSL (если применимо к bpm_search_records) */
  criteria?: unknown;
  join?: 'and' | 'or';
}

export function encodeCursor(state: CursorState): string {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(state)) {
    if (v !== undefined) clean[k] = v;
  }
  const json = JSON.stringify(clean);
  return Buffer.from(json, 'utf8').toString('base64url');
}

export function decodeCursor(token: string): CursorState {
  let json: string;
  try {
    json = Buffer.from(token, 'base64url').toString('utf8');
  } catch {
    throw new Error(`Невалидный cursor: не удалось декодировать base64url`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`Невалидный cursor: содержимое не является JSON`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Невалидный cursor: ожидался объект');
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.v !== 1) {
    throw new Error(`Неподдерживаемая версия cursor: ${String(obj.v)}`);
  }
  if (typeof obj.collection !== 'string') {
    throw new Error('Невалидный cursor: отсутствует collection');
  }
  if (typeof obj.skip !== 'number' || !Number.isFinite(obj.skip) || obj.skip < 0) {
    throw new Error('Невалидный cursor: некорректный skip');
  }
  return parsed as CursorState;
}

/**
 * Build a `next` cursor for the next page given the current state and how many
 * records were returned. Returns undefined if there's no next page (no nextLink
 * and the current chunk is smaller than top).
 */
export function buildNextCursor(state: CursorState, returnedCount: number, hasMore: boolean): string | undefined {
  if (!hasMore && (state.top === undefined || returnedCount < state.top)) return undefined;
  const next: CursorState = { ...state, skip: state.skip + returnedCount };
  return encodeCursor(next);
}
