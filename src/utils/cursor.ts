import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { READ_FORMATS, type RenderFormat } from './render.js';

const SIGNING_KEY = randomBytes(32);
const TTL_MS = 30 * 60 * 1000;
const MAX_TOKEN_LENGTH = 65536;

export interface CursorState {
  v: 1;
  collection: string;
  filter?: string;
  select?: string;
  orderby?: string;
  expand?: string;
  count?: boolean;
  top?: number;
  /** Internal paging mode inherited by cursor-only read calls. */
  autoPaginate?: boolean;
  /** Text presentation selected on the original read call. */
  format?: RenderFormat;
  /** Lookup/reference presentation selected on the original read call. */
  resolveReferences?: boolean;
  skip: number;
  nextLink?: string;
  criteria?: unknown;
  join?: 'and' | 'or';
}

function scopeHash(scope: string): string {
  return createHash('sha256').update(scope).digest('hex');
}

function validate(state: unknown): asserts state is CursorState {
  if (!state || typeof state !== 'object' || Array.isArray(state))
    throw new Error('Невалидный cursor: ожидался объект');
  const obj = state as Record<string, unknown>;
  if (obj.v !== 1) throw new Error('Неподдерживаемая версия cursor');
  if (typeof obj.collection !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(obj.collection))
    throw new Error('Невалидный cursor: некорректная коллекция');
  if (!Number.isSafeInteger(obj.skip) || Number(obj.skip) < 0)
    throw new Error('Невалидный cursor: некорректный skip');
  if (obj.top !== undefined && (!Number.isInteger(obj.top) || Number(obj.top) < 1 || Number(obj.top) > 20000))
    throw new Error('Невалидный cursor: некорректный top');
  for (const field of ['filter', 'select', 'orderby', 'expand', 'nextLink']) {
    if (obj[field] !== undefined && (typeof obj[field] !== 'string' || String(obj[field]).length > 20000))
      throw new Error(`Невалидный cursor: некорректный ${field}`);
  }
  if (obj.count !== undefined && typeof obj.count !== 'boolean')
    throw new Error('Невалидный cursor: некорректный count');
  if (obj.autoPaginate !== undefined && typeof obj.autoPaginate !== 'boolean')
    throw new Error('Невалидный cursor: некорректный autoPaginate');
  if (obj.format !== undefined && !READ_FORMATS.includes(obj.format as RenderFormat))
    throw new Error('Невалидный cursor: некорректный format');
  if (obj.resolveReferences !== undefined && typeof obj.resolveReferences !== 'boolean')
    throw new Error('Невалидный cursor: некорректный resolveReferences');
}

/** Signed continuation, bound to the connection and caller supplied by the tool. */
export function encodeCursor(state: CursorState, scope = ''): string {
  validate(state);
  const body = Buffer.from(
    JSON.stringify({ state, expires: Date.now() + TTL_MS, scope: scopeHash(scope) })
  ).toString('base64url');
  const signature = createHmac('sha256', SIGNING_KEY).update(body).digest('base64url');
  const token = `${body}.${signature}`;
  if (token.length > MAX_TOKEN_LENGTH) throw new Error('Параметры запроса слишком велики для cursor');
  return token;
}

export function decodeCursor(token: string, scope = ''): CursorState {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) throw new Error('Невалидный cursor');
  const parts = token.split('.');
  if (parts.length !== 2) throw new Error('Невалидный cursor: отсутствует подпись');
  const [body, signature] = parts;
  const expected = createHmac('sha256', SIGNING_KEY).update(body).digest();
  const received = Buffer.from(signature, 'base64url');
  if (received.length !== expected.length || !timingSafeEqual(received, expected))
    throw new Error('Невалидный cursor: подпись не совпадает');
  let envelope: { state: unknown; expires: number; scope: string };
  try {
    envelope = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Невалидный cursor: содержимое не является JSON');
  }
  if (!Number.isFinite(envelope.expires) || envelope.expires <= Date.now())
    throw new Error('Cursor истёк. Повторите исходный поиск.');
  if (envelope.scope !== scopeHash(scope))
    throw new Error('Cursor принадлежит другому подключению или пользователю');
  validate(envelope.state);
  return envelope.state;
}

export function buildNextCursor(
  state: CursorState,
  returnedCount: number,
  hasMore: boolean,
  scope = ''
): string | undefined {
  if (!hasMore || (returnedCount === 0 && !state.nextLink)) return undefined;
  return encodeCursor({ ...state, skip: state.skip + returnedCount }, scope);
}
