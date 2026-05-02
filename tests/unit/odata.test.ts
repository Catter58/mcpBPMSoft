import { describe, it, expect } from 'vitest';
import {
  isSafeIdentifier,
  isSafePath,
  escapeODataString,
  assertSafeIdentifier,
} from '../../src/utils/odata.js';

describe('isSafeIdentifier', () => {
  it('accepts plain ASCII identifiers', () => {
    expect(isSafeIdentifier('Name')).toBe(true);
    expect(isSafeIdentifier('_x')).toBe(true);
    expect(isSafeIdentifier('Field1')).toBe(true);
  });

  it('rejects empty, leading-digit, whitespace, dots, injection', () => {
    expect(isSafeIdentifier('')).toBe(false);
    expect(isSafeIdentifier('1abc')).toBe(false);
    expect(isSafeIdentifier(' ')).toBe(false);
    expect(isSafeIdentifier('Name; DROP')).toBe(false);
    expect(isSafeIdentifier("Name eq 'x'")).toBe(false);
    expect(isSafeIdentifier('a.b')).toBe(false);
  });
});

describe('isSafePath', () => {
  it('accepts navigation paths with slashes', () => {
    expect(isSafePath('Account/Name')).toBe(true);
    expect(isSafePath('_x/_y')).toBe(true);
  });

  it('rejects traversal and whitespace', () => {
    expect(isSafePath('../etc')).toBe(false);
    expect(isSafePath('a b/c')).toBe(false);
  });
});

describe('escapeODataString', () => {
  it("doubles single quotes", () => {
    expect(escapeODataString("O'Brien")).toBe("O''Brien");
  });

  it('strips CR/LF and turns tabs into spaces', () => {
    expect(escapeODataString('a\nb')).toBe('ab');
    expect(escapeODataString('a\rb')).toBe('ab');
    expect(escapeODataString('a\tb')).toBe('a b');
    expect(escapeODataString("a'b\nc\td")).toBe("a''bc d");
  });
});

describe('assertSafeIdentifier', () => {
  it('throws on bad input', () => {
    expect(() => assertSafeIdentifier('1abc')).toThrow();
    expect(() => assertSafeIdentifier(' ')).toThrow();
    expect(() => assertSafeIdentifier('a.b', 'field')).toThrow(/field/);
  });

  it('returns silently on good input', () => {
    expect(() => assertSafeIdentifier('Name')).not.toThrow();
  });
});
