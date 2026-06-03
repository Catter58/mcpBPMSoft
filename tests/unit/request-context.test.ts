import { describe, it, expect } from 'vitest';
import {
  parseCookieString,
  extractAuthFromHeaders,
  runWithAuth,
  getRequestAuth,
  hasRequestAuth,
} from '../../src/auth/request-context.js';

describe('parseCookieString', () => {
  it('parses key=value pairs', () => {
    const m = parseCookieString('a=1; b=2; c=hello world');
    expect(m.get('a')).toBe('1');
    expect(m.get('b')).toBe('2');
    expect(m.get('c')).toBe('hello world');
  });

  it('returns empty map for empty input', () => {
    expect(parseCookieString('').size).toBe(0);
  });
});

describe('extractAuthFromHeaders', () => {
  it('pulls BPMCSRF header and only the forwarded cookies', () => {
    const auth = extractAuthFromHeaders({
      BPMCSRF: 'csrf-xyz',
      Cookie: '.ASPXAUTH=aaa; BPMSESSIONID=sss; CsrfToken=ttt; Irrelevant=zzz',
    });
    expect(auth.csrfToken).toBe('csrf-xyz');
    expect(auth.cookies.get('.ASPXAUTH')).toBe('aaa');
    expect(auth.cookies.get('BPMSESSIONID')).toBe('sss');
    expect(auth.cookies.get('CsrfToken')).toBe('ttt');
    expect(auth.cookies.has('Irrelevant')).toBe(false);
  });

  it('is case-insensitive for header names', () => {
    const auth = extractAuthFromHeaders({ bpmcsrf: 'c', cookie: 'CsrfToken=t' });
    expect(auth.csrfToken).toBe('c');
    expect(auth.cookies.get('CsrfToken')).toBe('t');
  });

  it('empty headers -> empty auth', () => {
    const auth = extractAuthFromHeaders(undefined);
    expect(auth.csrfToken).toBeUndefined();
    expect(auth.cookies.size).toBe(0);
    expect(hasRequestAuth(auth)).toBe(false);
  });
});

describe('runWithAuth / getRequestAuth isolation', () => {
  it('exposes auth inside the context and undefined outside', () => {
    expect(getRequestAuth()).toBeUndefined();
    const a = extractAuthFromHeaders({ bpmcsrf: 'A', cookie: 'CsrfToken=ta' });
    runWithAuth(a, () => {
      expect(getRequestAuth()?.csrfToken).toBe('A');
    });
    expect(getRequestAuth()).toBeUndefined();
  });

  it('two parallel contexts do not leak cookies into each other', async () => {
    const a = extractAuthFromHeaders({ bpmcsrf: 'A', cookie: 'BPMSESSIONID=sa' });
    const b = extractAuthFromHeaders({ bpmcsrf: 'B', cookie: 'BPMSESSIONID=sb' });

    const seen: string[] = [];
    await Promise.all([
      runWithAuth(a, async () => {
        await new Promise((r) => setTimeout(r, 5));
        seen.push(`a:${getRequestAuth()?.csrfToken}:${getRequestAuth()?.cookies.get('BPMSESSIONID')}`);
      }),
      runWithAuth(b, async () => {
        seen.push(`b:${getRequestAuth()?.csrfToken}:${getRequestAuth()?.cookies.get('BPMSESSIONID')}`);
      }),
    ]);

    expect(seen).toContain('a:A:sa');
    expect(seen).toContain('b:B:sb');
  });
});
