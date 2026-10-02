import type { EntityProperty } from '../types/index.js';
import { coerceFieldValue, isNumericType } from '../utils/field-values.js';
import { BpmApiError } from '../utils/errors.js';
import { normalizeName } from '../utils/name-normalize.js';
import {
  type Decimal,
  decimal,
  addDecimal,
  compareDecimal,
  decimalText,
  divideDecimal,
} from '../utils/decimal.js';

export type MetricOp = 'sum' | 'avg' | 'min' | 'max';
export interface ResolvedMetric {
  property: EntityProperty;
  op: MetricOp;
  alias: string;
}
interface Accumulator {
  count: number;
  sum: Decimal;
  min?: Decimal;
  max?: Decimal;
}
export interface AggregateGroup {
  dimensions: Record<string, unknown>;
  count: number;
  metrics: Record<string, string | null>;
  metric_counts: Record<string, number>;
}
export interface DuplicateGroup {
  normalized_key: Record<string, unknown>;
  dimensions: Record<string, unknown>;
  count: number;
  record_ids: string[];
  sample_records: Array<Record<string, unknown>>;
}

function average(sum: Decimal, count: number): string {
  return decimalText(divideDecimal(sum, decimal(count), 6), true);
}

export function aggregateRecords(
  records: Array<Record<string, unknown>>,
  dimensions: EntityProperty[],
  metrics: ResolvedMetric[],
  collection: string
): AggregateGroup[] {
  const groups = new Map<
    string,
    { dimensions: Record<string, unknown>; count: number; values: Map<string, Accumulator> }
  >();
  const ensureGroup = (values: Record<string, unknown>) => {
    const key = JSON.stringify(values);
    let group = groups.get(key);
    if (!group) {
      group = { dimensions: values, count: 0, values: new Map() };
      groups.set(key, group);
    }
    return group;
  };
  if (dimensions.length === 0) ensureGroup({});
  for (const record of records) {
    const values: Record<string, unknown> = {};
    for (const property of dimensions) {
      const raw = record[property.name] ?? null;
      values[property.name] =
        property.isLookup && raw === '00000000-0000-0000-0000-000000000000'
          ? null
          : coerceFieldValue(raw, property, collection, { allowNull: true });
    }
    const group = ensureGroup(values);
    group.count++;
    for (const metric of metrics) {
      if (!isNumericType(metric.property.type))
        throw new BpmApiError(`Поле "${metric.property.name}" не является числовым.`, 400, collection);
      const raw = record[metric.property.name];
      if (raw === null || raw === undefined) continue;
      const typed = coerceFieldValue(raw, metric.property, collection);
      if (typeof typed !== 'string' && typeof typed !== 'number')
        throw new BpmApiError('Некорректное числовое значение.', 502, collection);
      const number = decimal(typed);
      const accumulator = group.values.get(metric.alias) ?? { count: 0, sum: { units: 0n, scale: 0 } };
      accumulator.count++;
      accumulator.sum = addDecimal(accumulator.sum, number);
      if (!accumulator.min || compareDecimal(number, accumulator.min) < 0) accumulator.min = number;
      if (!accumulator.max || compareDecimal(number, accumulator.max) > 0) accumulator.max = number;
      group.values.set(metric.alias, accumulator);
    }
  }
  return [...groups.values()]
    .map((group) => {
      const output: AggregateGroup = {
        dimensions: group.dimensions,
        count: group.count,
        metrics: {},
        metric_counts: {},
      };
      for (const metric of metrics) {
        const value = group.values.get(metric.alias);
        output.metric_counts[metric.alias] = value?.count ?? 0;
        output.metrics[metric.alias] = !value
          ? null
          : metric.op === 'avg'
            ? average(value.sum, value.count)
            : decimalText(metric.op === 'sum' ? value.sum : metric.op === 'min' ? value.min! : value.max!);
      }
      return output;
    })
    .sort(
      (a, b) => b.count - a.count || JSON.stringify(a.dimensions).localeCompare(JSON.stringify(b.dimensions))
    );
}

function duplicateKey(value: unknown, property: EntityProperty, collection: string): unknown {
  if (
    value === null ||
    value === undefined ||
    value === '' ||
    value === '00000000-0000-0000-0000-000000000000'
  )
    return null;
  const typed = coerceFieldValue(value, property, collection, { allowNull: true });
  if (typeof typed !== 'string') return typed;
  const name = property.name.toLowerCase();
  const trimmed = typed.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
  if (name.includes('email')) return trimmed || null;
  if (name.includes('phone')) return trimmed.replace(/\D/g, '') || null;
  if (property.type === 'Edm.String' && (name.includes('name') || name === 'title'))
    return normalizeName(trimmed).core || null;
  return trimmed || null;
}

export function findDuplicateGroups(
  records: Array<Record<string, unknown>>,
  fields: EntityProperty[],
  collection: string
): DuplicateGroup[] {
  const grouped = new Map<string, DuplicateGroup>();
  for (const record of records) {
    const normalized: Record<string, unknown> = {};
    const dimensions: Record<string, unknown> = {};
    for (const property of fields) {
      normalized[property.name] = duplicateKey(record[property.name], property, collection);
      dimensions[property.name] = record[property.name] ?? null;
    }
    // Missing identifiers provide no evidence that two business records are equal.
    if (Object.values(normalized).some((value) => value === null)) continue;
    if (typeof record.Id !== 'string' || !record.Id)
      throw new BpmApiError('Сервер вернул запись без Id при проверке дублей.', 502, collection);
    const key = JSON.stringify(normalized);
    const group = grouped.get(key) ?? {
      normalized_key: normalized,
      dimensions,
      count: 0,
      record_ids: [],
      sample_records: [],
    };
    group.count++;
    // Keep response bounded while preserving the true observed group size.
    if (group.record_ids.length < 20) group.record_ids.push(record.Id);
    if (group.sample_records.length < 5) group.sample_records.push(record);
    grouped.set(key, group);
  }
  return [...grouped.values()]
    .filter((group) => group.count > 1)
    .sort(
      (a, b) =>
        b.count - a.count || JSON.stringify(a.normalized_key).localeCompare(JSON.stringify(b.normalized_key))
    );
}
