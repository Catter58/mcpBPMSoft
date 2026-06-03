/**
 * Per-request authentication context.
 *
 * Carries the caller's BPMCSRF token and session cookies extracted from the
 * incoming HTTP request through the async call stack via AsyncLocalStorage,
 * so each request is isolated (no cross-user cookie leakage) and no secrets
 * are stored on the server (mcp-proxy-server pattern).
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestAuth {
  /** BPMCSRF token from the incoming request header. */
  csrfToken?: string;
  /** Forwarded session cookies. */
  cookies: Map<string, string>;
}

/** Cookies forwarded to BPMSoft — same set as mcp-proxy-server. */
export const FORWARDED_COOKIE_KEYS = ['.ASPXAUTH', 'BPMSESSIONID', 'CsrfToken'] as const;

const storage = new AsyncLocalStorage<RequestAuth>();

/** Parse a raw `Cookie` header string into a Map. */
export function parseCookieString(cookie: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!cookie) return out;
  for (const part of cookie.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
  }
  return out;
}

type HeaderBag = Record<string, string | string[] | undefined> | Headers | undefined;

function getHeader(headers: HeaderBag, name: string): string | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

/** Build RequestAuth from incoming request headers (BPMCSRF + selected cookies). */
export function extractAuthFromHeaders(headers: HeaderBag): RequestAuth {
  const csrfToken = getHeader(headers, 'bpmcsrf') || undefined;
  const parsed = parseCookieString(getHeader(headers, 'cookie') || '');

  const cookies = new Map<string, string>();
  for (const key of FORWARDED_COOKIE_KEYS) {
    const val = parsed.get(key);
    if (val !== undefined) cookies.set(key, val);
  }
  const bpmcsrfCookie = parsed.get('BPMCSRF');
  if (bpmcsrfCookie !== undefined) cookies.set('BPMCSRF', bpmcsrfCookie);

  return { csrfToken, cookies };
}

/** Run `fn` with the given auth bound to the async context. */
export function runWithAuth<T>(auth: RequestAuth, fn: () => T): T {
  return storage.run(auth, fn);
}

/** Get the auth bound to the current async context, if any. */
export function getRequestAuth(): RequestAuth | undefined {
  return storage.getStore();
}

/** True when the auth carries usable credentials (token or at least one cookie). */
export function hasRequestAuth(auth: RequestAuth | undefined): auth is RequestAuth {
  return !!auth && (!!auth.csrfToken || auth.cookies.size > 0);
}
