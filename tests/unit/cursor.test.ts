import { describe, expect, it, vi } from 'vitest';
import { buildNextCursor, decodeCursor, encodeCursor } from '../../src/utils/cursor.js';

describe('signed pagination cursor', () => {
  const state = {
    v: 1 as const,
    collection: 'Contact',
    skip: 0,
    top: 5,
    nextLink: 'Contact?$skiptoken=opaque',
  };
  it('preserves a server continuation without rebuilding its token', () => {
    expect(decodeCursor(encodeCursor(state, 'user-a'), 'user-a')).toEqual(state);
  });
  it('rejects tampering and reuse by another identity', () => {
    const token = encodeCursor(state, 'user-a');
    expect(() => decodeCursor(token, 'user-b')).toThrow(/пользователю/);
    expect(() => decodeCursor(`A${token.slice(1)}`, 'user-a')).toThrow(/подпись/);
  });
  it('expires and never fabricates continuation for a complete page', () => {
    const token = encodeCursor(state);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60 * 1000);
    try {
      expect(() => decodeCursor(token)).toThrow(/истёк/);
    } finally {
      vi.restoreAllMocks();
    }
    expect(buildNextCursor(state, 5, false)).toBeUndefined();
  });
  it('rejects fractional offsets and oversized page sizes', () => {
    expect(() => encodeCursor({ ...state, skip: 1.5 })).toThrow(/skip/);
    expect(() => encodeCursor({ ...state, top: 20001 })).toThrow(/top/);
    expect(() => encodeCursor({ ...state, autoPaginate: 'yes' as never })).toThrow(/autoPaginate/);
  });
  it('preserves optional bounded-page mode while accepting older cursor states', () => {
    expect(decodeCursor(encodeCursor({ ...state, autoPaginate: true }), '')).toMatchObject({
      autoPaginate: true,
    });
    expect(decodeCursor(encodeCursor(state), '')).toEqual(state);
  });
  it('persists an optional summary format and accepts earlier states without format', () => {
    expect(decodeCursor(encodeCursor({ ...state, format: 'summary' }), '')).toMatchObject({
      format: 'summary',
    });
    expect(decodeCursor(encodeCursor(state), '')).toEqual(state);
    expect(() => encodeCursor({ ...state, format: 'unexpected' as never })).toThrow(/format/);
  });
  it('persists reference-resolution choice while accepting older states without it', () => {
    expect(decodeCursor(encodeCursor({ ...state, resolveReferences: false }), '')).toMatchObject({
      resolveReferences: false,
    });
    expect(decodeCursor(encodeCursor(state), '')).toEqual(state);
    expect(() => encodeCursor({ ...state, resolveReferences: 'no' as never })).toThrow(/resolveReferences/);
  });
  it('keeps summary and reference choices on the next signed page', () => {
    const token = buildNextCursor(
      { ...state, format: 'summary', resolveReferences: false },
      2,
      true,
      'user-a'
    );
    expect(decodeCursor(token!, 'user-a')).toMatchObject({
      skip: 2,
      format: 'summary',
      resolveReferences: false,
    });
  });
  it('preserves native continuation on an empty filtered page', () => {
    const token = buildNextCursor(state, 0, true, 'user-a');
    expect(decodeCursor(token!, 'user-a')).toEqual(state);
    expect(buildNextCursor({ ...state, nextLink: undefined }, 0, true)).toBeUndefined();
  });
});
