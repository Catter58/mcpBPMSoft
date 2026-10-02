import { describe, expect, it } from 'vitest';
import { decimal, decimalText, divideDecimal, roundDecimal } from '../../src/utils/decimal.js';

describe('exact Decimal rounding', () => {
  it.each([
    ['1.005', '1.01'],
    ['-1.005', '-1.01'],
    ['1.0049999999999999999999', '1'],
    ['-0.004', '0'],
    ['9007199254740993.015', '9007199254740993.02'],
    ['.125e1', '1.25'],
  ])('rounds %s to cents as %s', (value, expected) => {
    expect(decimalText(roundDecimal(decimal(value), 2))).toBe(expected);
  });

  it('rounds quotients with negative divisors and preserves fixed-scale averages', () => {
    expect(decimalText(divideDecimal(decimal('0.01'), decimal('-2'), 2))).toBe('-0.01');
    expect(decimalText(divideDecimal(decimal('-1'), decimal('3'), 6), true)).toBe('-0.333333');
  });

  it.each(['', '.', '+', 'NaN', 'Infinity', '1e1001'])('rejects invalid or oversized Decimal %s', (value) => {
    expect(() => decimal(value)).toThrow();
  });

  it('rejects division by zero', () => {
    expect(() => divideDecimal(decimal('1'), decimal('0'), 2)).toThrow(/ноль/);
  });
});
