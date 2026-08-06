import { describe, it, expect } from 'vitest';
import {
  BpmApiError,
  LookupResolutionError,
  parseODataError,
  formatToolError,
  AuthRequiredError,
} from '../../src/utils/errors.js';

describe('BpmApiError.toString', () => {
  it('includes status, collection and details', () => {
    const e = new BpmApiError('boom', 500, 'Contact', 'inner cause');
    const s = e.toString();
    expect(s).toContain('boom');
    expect(s).toContain('500');
    expect(s).toContain('Contact');
    expect(s).toContain('inner cause');
  });

  it('omits optional pieces when not provided', () => {
    const e = new BpmApiError('nope', 404);
    const s = e.toString();
    expect(s).toContain('nope');
    expect(s).toContain('404');
    expect(s).not.toContain('Коллекция');
    expect(s).not.toContain('Детали');
  });
});

describe('parseODataError', () => {
  it('extracts message from a v4 error envelope', () => {
    const out = parseODataError({ error: { code: 'X', message: 'Bad' } });
    expect(out).toBe('Bad');
  });

  it('returns undefined for non-OData bodies', () => {
    expect(parseODataError(null)).toBeUndefined();
    expect(parseODataError({ foo: 'bar' })).toBeUndefined();
    expect(parseODataError('just a string')).toBeUndefined();
  });
});

describe('formatToolError', () => {
  it('handles BpmApiError', () => {
    const e = new BpmApiError('boom', 500, 'Contact', 'cause');
    const out = formatToolError(e);
    expect(out.success).toBe(false);
    expect(out.error).toBe('boom');
    expect(out.httpStatus).toBe(500);
    expect(out.collection).toBe('Contact');
    expect(out.details).toBe('cause');
  });

  it('handles LookupResolutionError with a single candidate (no details)', () => {
    const e = new LookupResolutionError('CityId', 'Moscow', 0, []);
    const out = formatToolError(e, 'Contact');
    expect(out.success).toBe(false);
    expect(out.collection).toBe('Contact');
    expect(out.details).toBeUndefined();
    expect(out.error).toContain('Moscow');
  });

  it('handles LookupResolutionError with multiple candidates (lists them)', () => {
    const e = new LookupResolutionError('CityId', 'Mos', 2, [
      { id: '1', displayValue: 'Moscow' },
      { id: '2', displayValue: 'Moskva' },
    ]);
    const out = formatToolError(e);
    expect(out.success).toBe(false);
    expect(out.details).toContain('Moscow');
    expect(out.details).toContain('Moskva');
  });

  it('handles a generic Error', () => {
    const out = formatToolError(new Error('plain'), 'Contact');
    expect(out).toMatchObject({ success: false, code: 'unknown', error: 'plain', collection: 'Contact' });
    expect(out.next_steps && out.next_steps.length).toBeGreaterThan(0);
  });

  it('handles a plain string', () => {
    const out = formatToolError('string error');
    expect(out.success).toBe(false);
    expect(out.error).toBe('string error');
  });
});

describe('AuthRequiredError', () => {
  it('is a 401 BpmApiError with a clear ToolError', () => {
    const err = new AuthRequiredError();
    expect(err.name).toBe('AuthRequiredError');
    expect(err.httpStatus).toBe(401);
    const tool = err.toToolError();
    expect(tool.success).toBe(false);
    expect(tool.error).toMatch(/BPMCSRF/);
    expect(tool.error).toMatch(/CsrfToken/);
    expect(tool.next_steps && tool.next_steps.length).toBeTruthy();
  });
});

describe('ToolError.code', () => {
  it('BpmApiError выводит код из httpStatus', () => {
    expect(new BpmApiError('x', 401).code).toBe('auth_required');
    expect(new BpmApiError('x', 403).code).toBe('auth_required');
    expect(new BpmApiError('x', 404).code).toBe('not_found');
    expect(new BpmApiError('x', 400).code).toBe('validation');
    expect(new BpmApiError('x', 500).code).toBe('odata_error');
  });

  it('явный код имеет приоритет над httpStatus', () => {
    const err = new BpmApiError('x', 0, undefined, undefined, undefined, undefined, 'batch_unsupported');
    expect(err.code).toBe('batch_unsupported');
    expect(err.toToolError().code).toBe('batch_unsupported');
  });

  it('LookupResolutionError: >1 матчей → lookup_ambiguous, 0 → not_found', () => {
    const many = formatToolError(new LookupResolutionError('CityId', 'X', 3, []));
    expect(many.code).toBe('lookup_ambiguous');
    const none = formatToolError(new LookupResolutionError('CityId', 'X', 0, []));
    expect(none.code).toBe('not_found');
  });

  it('next_steps непустой для любого кода', () => {
    for (const err of [new BpmApiError('x', 500), new Error('generic'), 'string']) {
      const out = formatToolError(err);
      expect(out.next_steps && out.next_steps.length).toBeGreaterThan(0);
    }
  });
});
