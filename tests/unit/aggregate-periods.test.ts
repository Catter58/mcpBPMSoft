import { describe, it, expect, vi } from 'vitest';
import * as z from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { QueryOptions } from '../../src/types/index.js';
import { bucketLabel, bucketLabelsInRange, previousPeriodRange } from '../../src/utils/datetime.js';
import {
  accumulate,
  buildGroups,
  computeDelta,
  parseDateValue,
  NO_DATE_BUCKET,
  registerAggregateTool,
} from '../../src/tools/aggregate-tool.js';

const MSK = 'Europe/Moscow';
const iso = (r: { from: Date; to: Date }) => [r.from.toISOString(), r.to.toISOString()];

describe('bucketLabel в поясе пользователя', () => {
  it('граница московской полуночи: 20:59Z — ещё 13-е, 21:00Z — уже 14-е', () => {
    expect(bucketLabel(new Date('2026-09-13T20:59:59Z'), 'day', MSK)).toBe('2026-09-13');
    expect(bucketLabel(new Date('2026-09-13T21:00:00Z'), 'day', MSK)).toBe('2026-09-14');
  });

  it('неделя с понедельника: воскресенье — прошлая неделя, понедельник по Москве — новая', () => {
    // 2026-09-14 — понедельник; 20:59Z воскресенья 13-го по Москве ещё воскресенье.
    expect(bucketLabel(new Date('2026-09-13T20:59:59Z'), 'week', MSK)).toBe('неделя с 2026-09-07');
    expect(bucketLabel(new Date('2026-09-13T21:00:00Z'), 'week', MSK)).toBe('неделя с 2026-09-14');
    expect(bucketLabel(new Date('2026-09-20T20:00:00Z'), 'week', MSK)).toBe('неделя с 2026-09-14');
    // Неделя через границу года.
    expect(bucketLabel(new Date('2027-01-01T09:00:00Z'), 'week', MSK)).toBe('неделя с 2026-12-28');
  });

  it('месяц, квартал и год считаются по местной дате', () => {
    const newYearMsk = new Date('2026-12-31T21:30:00Z');
    expect(bucketLabel(newYearMsk, 'month', MSK)).toBe('2027-01');
    expect(bucketLabel(newYearMsk, 'quarter', MSK)).toBe('2027-Q1');
    expect(bucketLabel(newYearMsk, 'year', MSK)).toBe('2027');
    expect(bucketLabel(new Date('2026-09-14T10:00:00Z'), 'quarter', MSK)).toBe('2026-Q3');
  });

  it('все интервалы периода по порядку', () => {
    const week = { from: new Date('2026-09-13T21:00:00Z'), to: new Date('2026-09-20T21:00:00Z') };
    const days = bucketLabelsInRange(week, 'day', MSK);
    expect(days).toHaveLength(7);
    expect(days[0]).toBe('2026-09-14');
    expect(days[6]).toBe('2026-09-20');
  });
});

describe('bpm_aggregate scan completeness', () => {
  function setup(
    rows: Array<Record<string, unknown>>,
    options: { serverPageSize?: number; nextLinks?: boolean; count?: boolean; ignoreTop?: boolean } = {}
  ) {
    let handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
    let input: z.ZodRawShape;
    let output: z.ZodRawShape;
    const queries: QueryOptions[] = [];
    registerAggregateTool(
      {
        registerTool(
          _name: string,
          definition: { inputSchema: z.ZodRawShape; outputSchema: z.ZodRawShape },
          registered: typeof handler
        ) {
          handler = registered;
          input = definition.inputSchema;
          output = definition.outputSchema;
        },
      } as never,
      {
        initialized: true,
        config: { odata_version: 4 },
        authManager: { async ensureAuthenticated() {} },
        metadataManager: {
          async resolveCollectionReference() {
            return { name: 'Contact' };
          },
          async resolveFieldReference(_collection: string, field: string) {
            return { name: field };
          },
          async getEntityMetadata() {
            return { properties: [{ name: 'Name', type: 'Edm.String' }] };
          },
        },
        odataClient: {
          async getRecords(_collection: string, query: QueryOptions) {
            queries.push(query);
            const skip = query.$skip ?? 0;
            const top = options.ignoreTop ? rows.length : (query.$top ?? 1000);
            const value = rows.slice(skip, skip + Math.min(top, options.serverPageSize ?? 1000));
            const hasNext = options.nextLinks && skip + value.length < rows.length && value.length < top;
            return {
              value,
              ...(options.count ? { '@odata.count': rows.length } : {}),
              ...(hasNext ? { '@odata.nextLink': 'https://bpm.test/odata/Contact?$skip=1' } : {}),
            };
          },
        },
      } as never
    );
    return {
      queries,
      async call(maxRecords: number) {
        const result = await handler!(
          z.object(input!).parse({
            collection: 'Contact',
            group_by: 'Name',
            metrics: [{ field: 'Amount', op: 'sum' }],
            filter: 'Amount ge 0',
            max_records: maxRecords,
          })
        );
        expect(result.isError).toBeUndefined();
        z.object(output!).parse(result.structuredContent);
        return result;
      },
    };
  }

  const rows = [
    { Id: 'a', Name: 'A', Amount: '1' },
    { Id: 'b', Name: 'A', Amount: '2' },
    { Id: 'c', Name: 'A', Amount: '1000' },
  ];

  it('reports a complete result when exactly max_records rows match and no count is available', async () => {
    const { call, queries } = setup(rows.slice(0, 2));
    const result = await call(2);
    expect(result.structuredContent).toMatchObject({
      scanned: 2,
      truncated: false,
      groups: [{ key: 'A', count: 2, metrics: { 'sum(Amount)': 3 } }],
    });
    expect(queries).toHaveLength(2);
    expect(queries[1]).toMatchObject({ $filter: 'Amount ge 0', $select: 'Id', $skip: 2, $top: 1 });
  });

  it('probes beyond the limit without including the extra row in groups or metrics', async () => {
    const { call, queries } = setup(rows);
    const result = await call(2);
    expect(result.structuredContent).toMatchObject({
      scanned: 2,
      truncated: true,
      groups: [{ key: 'A', count: 2, metrics: { 'sum(Amount)': 3 } }],
    });
    expect(queries[1]).toMatchObject({ $filter: 'Amount ge 0', $skip: 2, $top: 1 });
  });

  it.each([{ nextLinks: true }, { count: true }])(
    'continues through short backend pages when continuation evidence is present: %o',
    async (evidence) => {
      const { call, queries } = setup(rows, { serverPageSize: 1, ...evidence });
      const result = await call(4);
      expect(result.structuredContent).toMatchObject({
        scanned: 3,
        truncated: false,
        groups: [{ count: 3, metrics: { 'sum(Amount)': 1003 } }],
      });
      expect(queries.map((query) => query.$skip)).toEqual([0, 1, 2]);
    }
  );

  it('honors max_records even if a backend ignores $top', async () => {
    const { call, queries } = setup(rows, { ignoreTop: true });
    const result = await call(2);
    expect(result.structuredContent).toMatchObject({
      scanned: 2,
      truncated: true,
      groups: [{ count: 2, metrics: { 'sum(Amount)': 3 } }],
    });
    expect(queries).toHaveLength(1);
  });
});

describe('previousPeriodRange', () => {
  const now = new Date('2026-09-14T10:00:00Z'); // понедельник

  it('эта неделя → прошлая, прошлая → позапрошлая', () => {
    expect(iso(previousPeriodRange('this_week', MSK, now))).toEqual([
      '2026-09-06T21:00:00.000Z',
      '2026-09-13T21:00:00.000Z',
    ]);
    expect(iso(previousPeriodRange('last_week', MSK, now))).toEqual([
      '2026-08-30T21:00:00.000Z',
      '2026-09-06T21:00:00.000Z',
    ]);
  });

  it('сегодня → вчера, вчера → позавчера', () => {
    expect(iso(previousPeriodRange('today', MSK, now))).toEqual([
      '2026-09-12T21:00:00.000Z',
      '2026-09-13T21:00:00.000Z',
    ]);
    expect(iso(previousPeriodRange('yesterday', MSK, now))[0]).toBe('2026-09-11T21:00:00.000Z');
  });

  it('месяц и квартал, в том числе через границу года', () => {
    expect(iso(previousPeriodRange('this_month', MSK, now))).toEqual([
      '2026-07-31T21:00:00.000Z',
      '2026-08-31T21:00:00.000Z',
    ]);
    expect(iso(previousPeriodRange('this_quarter', MSK, now))).toEqual([
      '2026-03-31T21:00:00.000Z',
      '2026-06-30T21:00:00.000Z',
    ]);
    const february = new Date('2027-02-10T10:00:00Z');
    expect(iso(previousPeriodRange('this_quarter', MSK, february))).toEqual([
      '2026-09-30T21:00:00.000Z',
      '2026-12-31T21:00:00.000Z',
    ]);
    expect(iso(previousPeriodRange('last_month', MSK, february))).toEqual([
      '2026-11-30T21:00:00.000Z',
      '2026-12-31T21:00:00.000Z',
    ]);
    expect(iso(previousPeriodRange('this_year', MSK, february))[0]).toBe('2025-12-31T21:00:00.000Z');
  });

  it('первая неделя года уходит в прошлый год', () => {
    const jan = new Date('2027-01-06T10:00:00Z'); // среда, неделя с 2027-01-04
    expect(iso(previousPeriodRange('this_week', MSK, jan))[0]).toBe('2026-12-27T21:00:00.000Z');
  });
});

describe('сравнение с предыдущим периодом', () => {
  it('computeDelta: разница и процент, при нуле «было» процента нет', () => {
    expect(computeDelta(6, 4)).toMatchObject({ count: 2, count_pct: 50, overall_difference: 2 });
    expect(computeDelta(1, 3)).toMatchObject({ count: -2, count_pct: -66.7, overall_difference: -2 });
    expect(computeDelta(3, 0)).toMatchObject({ count: 3, count_pct: null, contribution_pct: 100 });
  });

  it('buildGroups сопоставляет интервалы по порядку и сохраняет группы, которых больше нет', () => {
    const labelKey = 'OwnerName';
    const current = new Map();
    const previous = new Map();
    accumulate(current, { OwnerId: 'a', OwnerName: 'Анна' }, 'OwnerId', labelKey, [], '2026-09-14');
    accumulate(current, { OwnerId: 'a', OwnerName: 'Анна' }, 'OwnerId', labelKey, [], '2026-09-14');
    accumulate(current, { OwnerId: 'a', OwnerName: 'Анна' }, 'OwnerId', labelKey, [], NO_DATE_BUCKET);
    accumulate(previous, { OwnerId: 'a', OwnerName: 'Анна' }, 'OwnerId', labelKey, [], '2026-09-07');
    accumulate(previous, { OwnerId: 'b', OwnerName: 'Борис' }, 'OwnerId', labelKey, [], '2026-09-08');

    const shift = new Map([
      ['2026-09-07', '2026-09-14'],
      ['2026-09-08', '2026-09-15'],
    ]);
    const groups = buildGroups(current, previous, [], (b) => (b ? (shift.get(b) ?? b) : b));

    expect(groups.map((g) => [g.bucket, g.label, g.previous_count, g.count])).toEqual([
      ['2026-09-14', 'Анна', 1, 2],
      ['2026-09-15', 'Борис', 1, 0],
      [NO_DATE_BUCKET, 'Анна', 0, 1],
    ]);
    expect(groups[0].delta).toMatchObject({ count: 1, count_pct: 100, overall_difference: 1 });
    expect(groups[1].delta).toMatchObject({ count: -1, count_pct: -100, overall_difference: 1 });
  });

  it('metric deltas use exact decimals, expose net contribution, and mark partial/null semantics', () => {
    const metrics = [
      { op: 'sum' as const, field: 'Value', label: 'sum(Value)' },
      { op: 'avg' as const, field: 'Value', label: 'avg(Value)' },
    ];
    const current = new Map();
    const previous = new Map();
    accumulate(current, { Segment: 'A', Value: '0.1' }, 'Segment', undefined, metrics);
    accumulate(current, { Segment: 'A', Value: '0.2' }, 'Segment', undefined, metrics);
    accumulate(previous, { Segment: 'A', Value: '0.1' }, 'Segment', undefined, metrics);
    accumulate(current, { Segment: 'B', Value: '3' }, 'Segment', undefined, metrics);
    accumulate(previous, { Segment: 'B', Value: '4' }, 'Segment', undefined, metrics);
    accumulate(current, { Segment: 'C', Value: '5' }, 'Segment', undefined, metrics);

    const groups = buildGroups(current, previous, metrics, undefined, false);
    const a = groups.find((g) => g.key === 'A')!;
    const b = groups.find((g) => g.key === 'B')!;
    const c = groups.find((g) => g.key === 'C')!;
    expect(a.metric_deltas?.['sum(Value)']).toMatchObject({
      current: '0.3',
      previous: '0.1',
      difference: '0.2',
      percent_change: '200',
      overall_difference: '4.2',
      contribution_pct: '4.761905',
      scope: 'observed_scan',
      partial: true,
    });
    expect(b.metric_deltas?.['sum(Value)']?.difference).toBe('-1');
    expect(c.metric_deltas?.['sum(Value)']).toMatchObject({
      current: '5',
      previous: '0',
      difference: '5',
      percent_change: null,
      null_reasons: { percent_change: 'baseline_zero' },
    });
    expect(a.metric_deltas?.['avg(Value)']).toMatchObject({
      current: '0.15',
      previous: '0.1',
      difference: '0.05',
      percent_change: '50',
      contribution_pct: null,
      null_reasons: { contribution_pct: 'contribution_requires_sum_metric' },
    });
    expect(a.delta).toMatchObject({ contribution_pct: 50, overall_difference: 2, scope: 'observed_scan' });
    expect(c.delta).toMatchObject({ contribution_pct: 50, overall_difference: 2 });
  });

  it('computes average delta and percent before rounding either period average', () => {
    const metric = [{ op: 'avg' as const, field: 'Value', label: 'avg(Value)' }];
    const current = new Map();
    const previous = new Map();
    accumulate(current, { Segment: 'A', Value: '1.0000001' }, 'Segment', undefined, metric);
    accumulate(previous, { Segment: 'A', Value: '1' }, 'Segment', undefined, metric);
    const [group] = buildGroups(current, previous, metric);
    expect(group.metric_deltas?.['avg(Value)']).toMatchObject({
      difference: '0.0000001',
      percent_change: '0.00001',
    });
  });

  it('без сравнения полей previous нет, сортировка по count', () => {
    const current = new Map();
    accumulate(current, { S: 'x' }, 'S', undefined, []);
    accumulate(current, { S: 'y' }, 'S', undefined, []);
    accumulate(current, { S: 'y' }, 'S', undefined, []);
    const groups = buildGroups(current, undefined, []);
    expect(groups.map((g) => g.label)).toEqual(['y', 'x']);
    expect(groups[0]).not.toHaveProperty('previous_count');
    expect(groups[0]).not.toHaveProperty('bucket');
  });

  it('parseDateValue: ISO, /Date(ms)/ и пустые значения', () => {
    expect(parseDateValue('2026-09-05T19:01:26.184176Z')?.toISOString()).toBe('2026-09-05T19:01:26.184Z');
    expect(parseDateValue('/Date(0)/')?.toISOString()).toBe('1970-01-01T00:00:00.000Z');
    expect(parseDateValue(null)).toBeNull();
    expect(parseDateValue('мусор')).toBeNull();
    expect(parseDateValue('2026-99-01')).toBeNull();
    expect(parseDateValue('2026-02-31')).toBeNull();
  });
});

describe('bpm_aggregate: неделя против прошлой по дням (данные как на тестовом стенде)', () => {
  const ME = '410006e1-ca4e-4502-a9ec-e54d922d2c00';
  const rows = [
    { Id: '1', StartDate: '2026-09-14T10:00:00Z' }, // пн 14-е по Москве
    { Id: '2', StartDate: '2026-09-14T22:00:00Z' }, // вт 15-е по Москве
    { Id: '3', StartDate: '2026-09-08T09:00:00Z' }, // вт прошлой недели
    { Id: '4', StartDate: '2026-09-13T20:30:00Z' }, // вс 13-е, 23:30 по Москве
  ];
  const queries: Array<Record<string, unknown>> = [];
  interface GroupOut {
    bucket?: string;
    previous_count?: number;
    count: number;
    delta?: { count: number; count_pct: number | null };
  }
  interface AggregateOut {
    period: { from: string; to: string };
    previous_period: { from: string; to: string };
    scanned: number;
    groups: GroupOut[];
  }
  type Handler = (
    args: Record<string, unknown>
  ) => Promise<{ structuredContent?: AggregateOut; content: Array<{ type: string; text?: string }> }>;

  function run(args: Record<string, unknown>) {
    let captured: Handler | undefined;
    const services = {
      initialized: true,
      config: { odata_version: 4 },
      authManager: { async ensureAuthenticated() {} },
      currentUser: {
        get: async () => ({ userId: 'u', userName: 'ApiUser', contactId: ME, timeZoneId: MSK }),
      },
      metadataManager: {
        async resolveCollectionReference() {
          return { name: 'Activity' };
        },
        async resolveFieldReference(_c: string, q: string) {
          return { name: q === 'Дата начала' ? 'StartDate' : q };
        },
      },
      odataClient: {
        async getRecords(_c: string, query: Record<string, unknown>) {
          queries.push(query);
          const [, from, to] = /StartDate ge (\S+) and StartDate lt (\S+)\)?$/.exec(String(query.$filter))!;
          const value = rows.filter((r) => r.StartDate >= from && r.StartDate < to);
          return { value };
        },
      },
    };
    registerAggregateTool(
      { registerTool: (_n: string, _m: unknown, h: Handler) => (captured = h) } as never,
      services as never
    );
    return captured!(args);
  }

  it('считает оба периода в поясе пользователя и сопоставляет дни по порядку', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-14T12:00:00Z'));
    try {
      const res = await run({
        collection: 'Activity',
        filter: `Owner/Id eq ${ME}`,
        date_field: 'Дата начала',
        bucket: 'day',
        period: 'на этой неделе',
        compare_previous: true,
      });
      const out = res.structuredContent;
      expect(queries[0].$filter).toBe(
        `(Owner/Id eq ${ME}) and (StartDate ge 2026-09-13T21:00:00Z and StartDate lt 2026-09-20T21:00:00Z)`
      );
      expect(queries[1].$filter).toContain(
        'StartDate ge 2026-09-06T21:00:00Z and StartDate lt 2026-09-13T21:00:00Z'
      );
      expect(queries[0]).toMatchObject({ $select: 'Id,StartDate', $skip: 0, $orderby: 'Id' });
      expect(out.period).toEqual({ from: '2026-09-13T21:00:00.000Z', to: '2026-09-20T21:00:00.000Z' });
      expect(out.previous_period.from).toBe('2026-09-06T21:00:00.000Z');
      expect(out.scanned).toBe(4);
      expect(out.groups.map((g) => [g.bucket, g.previous_count, g.count, g.delta?.count_pct])).toEqual([
        ['2026-09-14', 0, 1, null],
        ['2026-09-15', 1, 1, 0],
        ['2026-09-20', 1, 0, -100],
      ]);
      expect(res.content[0].text).toContain('2026-09-15: 1 → 1 (0, 0%)');
    } finally {
      vi.useRealTimers();
    }
  });

  it('period без date_field — понятная ошибка', async () => {
    const res = await run({ collection: 'Activity', period: 'вчера' });
    expect(res.content[0].text).toContain('date_field');
  });
});
