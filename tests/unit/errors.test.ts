import { describe, it, expect } from 'vitest';
import {
  BpmApiError,
  LookupResolutionError,
  parseODataError,
  formatToolError,
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
    expect(out).toEqual({ success: false, error: 'plain', collection: 'Contact' });
  });

  it('handles a plain string', () => {
    const out = formatToolError('string error');
    expect(out.success).toBe(false);
    expect(out.error).toBe('string error');
  });
});
