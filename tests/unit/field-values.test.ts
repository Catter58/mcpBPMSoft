import { describe, expect, it } from 'vitest';
import { coerceFieldValue, literalizeFieldValue } from '../../src/utils/field-values.js';
import type { EntityProperty } from '../../src/types/index.js';

const prop = (type: string, nullable = true): EntityProperty => ({
  name: 'Value',
  type,
  nullable,
  isLookup: false,
});

describe('metadata typed values', () => {
  it.each(['2026-01-01', '11111111-1111-1111-1111-111111111111', 'false', '17'])(
    'keeps string %s as a quoted string',
    (value) => {
      expect(literalizeFieldValue(value, prop('Edm.String'), 4)).toBe(`'${value}'`);
    }
  );
  it('preserves exact decimal and Int64 strings', () => {
    expect(coerceFieldValue('9007199254740993', prop('Edm.Int64'))).toBe('9007199254740993');
    expect(coerceFieldValue(1500.5, prop('Edm.Decimal'))).toBe('1500.5');
    expect(literalizeFieldValue('10000000000000000.01', prop('Edm.Decimal'), 4)).toBe('10000000000000000.01');
  });
  it('rejects decimal numbers already outside precise integer representation', () => {
    expect(() => coerceFieldValue(10000000000000000, prop('Edm.Decimal'))).toThrow('сохранить точность');
  });
  it.each([
    ['Edm.Int32', '3.5'],
    ['Edm.Int32', '2147483648'],
    ['Edm.Int64', 9007199254740992],
    ['Edm.Boolean', 'yes'],
    ['Edm.Guid', 'city'],
    ['Edm.String', { object: true }],
  ])('rejects invalid %s value', (type, value) => {
    expect(() => coerceFieldValue(value, prop(String(type)))).toThrow();
  });
  it('coerces ordinary numeric and boolean strings', () => {
    expect(coerceFieldValue('42', prop('Edm.Int32'))).toBe(42);
    expect(coerceFieldValue('false', prop('Edm.Boolean'))).toBe(false);
  });
  it.each(['2026-02-30', '2026-01-01T12:00:00', '2026-01-01T24:00:00Z', 'yesterday'])(
    'rejects non-existing or ambiguous date %s',
    (value) => {
      expect(() => coerceFieldValue(value, prop('Edm.DateTimeOffset'))).toThrow();
    }
  );
  it('converts explicit date offsets to a stable UTC instant', () => {
    expect(coerceFieldValue('2026-01-01T12:00:00+03:00', prop('Edm.DateTimeOffset'))).toBe(
      '2026-01-01T09:00:00.000Z'
    );
    expect(literalizeFieldValue('2026-01-01T12:00:00+03:00', prop('Edm.DateTimeOffset'), 3)).toBe(
      "datetimeoffset'2026-01-01T09:00:00Z'"
    );
  });
  it('rejects absent values and nonnullable write null but permits null comparisons', () => {
    expect(() => coerceFieldValue(undefined, prop('Edm.String'))).toThrow();
    expect(() => coerceFieldValue(null, prop('Edm.String', false))).toThrow();
    expect(literalizeFieldValue(null, prop('Edm.String', false), 4)).toBe('null');
  });
});
