import { BpmApiError } from './errors.js';

/** A base-10 coefficient and scale; never passes through binary floating arithmetic. */
export interface Decimal {
  units: bigint;
  scale: number;
}

export function decimal(value: string | number): Decimal {
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(String(value).trim());
  if (!match) throw new BpmApiError('Сервер вернул некорректное числовое значение.', 502);
  const fraction = match[3] ?? match[4] ?? '';
  const scale = fraction.length - Number(match[5] ?? 0);
  if (Math.abs(scale) > 1000) throw new BpmApiError('Масштаб числового значения слишком велик.', 502);
  const units = BigInt(`${match[1] === '-' ? '-' : ''}${match[2] || '0'}${fraction}`);
  return scale < 0 ? { units: units * 10n ** BigInt(-scale), scale: 0 } : { units, scale };
}

function align(value: Decimal, scale: number): bigint {
  return value.units * 10n ** BigInt(scale - value.scale);
}

export function addDecimal(left: Decimal, right: Decimal): Decimal {
  const scale = Math.max(left.scale, right.scale);
  return { units: align(left, scale) + align(right, scale), scale };
}

export function subtractDecimal(left: Decimal, right: Decimal): Decimal {
  return addDecimal(left, { units: -right.units, scale: right.scale });
}

export function multiplyDecimal(left: Decimal, right: Decimal): Decimal {
  return { units: left.units * right.units, scale: left.scale + right.scale };
}

export function compareDecimal(left: Decimal, right: Decimal): number {
  const scale = Math.max(left.scale, right.scale);
  const a = align(left, scale);
  const b = align(right, scale);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Half-up: exact ties round away from zero, also for refunds/negative corrections. */
export function divideDecimal(left: Decimal, right: Decimal, scale: number): Decimal {
  if (!Number.isInteger(scale) || scale < 0 || scale > 1000)
    throw new BpmApiError('Масштаб числового значения слишком велик.', 502);
  if (right.units === 0n) throw new BpmApiError('Деление числового значения на ноль.', 502);
  let numerator = left.units * 10n ** BigInt(right.scale + scale);
  let denominator = right.units * 10n ** BigInt(left.scale);
  if (denominator < 0n) {
    numerator = -numerator;
    denominator = -denominator;
  }
  let units = numerator / denominator;
  const remainder = numerator % denominator;
  if ((remainder < 0n ? -remainder : remainder) * 2n >= denominator) units += numerator < 0n ? -1n : 1n;
  return { units, scale };
}

export function roundDecimal(value: Decimal, scale: number): Decimal {
  return divideDecimal(value, { units: 1n, scale: 0 }, scale);
}

export function decimalText(value: Decimal, fixed = false): string {
  const negative = value.units < 0n;
  const digits = (negative ? -value.units : value.units).toString().padStart(value.scale + 1, '0');
  const body = value.scale === 0 ? digits : `${digits.slice(0, -value.scale)}.${digits.slice(-value.scale)}`;
  return `${negative ? '-' : ''}${fixed ? body : body.includes('.') ? body.replace(/0+$/, '').replace(/\.$/, '') : body}`;
}
