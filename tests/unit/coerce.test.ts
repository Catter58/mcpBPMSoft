import { describe, it, expect, vi, afterEach } from 'vitest';
import { coerceValue, needsTimeZone } from '../../src/utils/coerce.js';
import { LookupResolver } from '../../src/lookup/lookup-resolver.js';
import type { BpmConfig } from '../../src/types/index.js';

const MSK = 'Europe/Moscow';
const c = (value: unknown, type: string, tz?: string) => coerceValue('F', value, type, tz);

describe('coerceValue', () => {
  afterEach(() => vi.useRealTimers());

  it('DateTimeOffset: местное время → UTC с Z в поясе пользователя', () => {
    expect(c('2026-09-25T15:00', 'Edm.DateTimeOffset', MSK)).toEqual({
      value: '2026-09-25T12:00:00Z',
      changed: true,
    });
    expect(c('2026-09-25 15:00', 'Edm.DateTimeOffset', MSK).value).toBe('2026-09-25T12:00:00Z');
    expect(c('25.09.2026 15:00', 'Edm.DateTimeOffset', MSK).value).toBe('2026-09-25T12:00:00Z');
    expect(c('25.09.2026', 'Edm.DateTimeOffset', MSK).value).toBe('2026-09-24T21:00:00Z');
    expect(c('2026-09-25', 'Edm.DateTimeOffset', MSK).value).toBe('2026-09-24T21:00:00Z');
    // DST: летом Берлин +2, зимой +1.
    expect(c('2026-07-01T10:00', 'Edm.DateTimeOffset', 'Europe/Berlin').value).toBe('2026-07-01T08:00:00Z');
    expect(c('2026-01-01T10:00', 'Edm.DateTimeOffset', 'Europe/Berlin').value).toBe('2026-01-01T09:00:00Z');
  });

  it('DateTimeOffset: ISO со смещением не трогается', () => {
    for (const v of ['2026-09-25T15:00:00+03:00', '2026-09-25T12:00:00Z', '2026-09-25T12:00:00.123Z']) {
      expect(c(v, 'Edm.DateTimeOffset', MSK)).toEqual({ value: v, changed: false });
      expect(needsTimeZone(v, 'Edm.DateTimeOffset')).toBe(false);
    }
    expect(needsTimeZone('25.09.2026', 'Edm.DateTimeOffset')).toBe(true);
    expect(needsTimeZone('да', 'Edm.Boolean')).toBe(false);
  });

  it('DateTimeOffset/Date: «сегодня»/«завтра 15:00» в поясе пользователя', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T22:30:00Z')); // в Москве уже 23 сентября
    expect(c('завтра 15:00', 'Edm.DateTimeOffset', MSK).value).toBe('2026-09-24T12:00:00Z');
    expect(c('Сегодня', 'Edm.DateTimeOffset', MSK).value).toBe('2026-09-22T21:00:00Z');
    expect(c('сегодня', 'Edm.Date', MSK).value).toBe('2026-09-23');
  });

  it('Date: DD.MM.YYYY → YYYY-MM-DD, ISO-дата не трогается', () => {
    expect(c('25.09.2026', 'Edm.Date').value).toBe('2026-09-25');
    expect(c('5.9.2026', 'Edm.Date').value).toBe('2026-09-05');
    expect(c('2026-09-25', 'Edm.Date')).toEqual({ value: '2026-09-25', changed: false });
  });

  it('Boolean: да/нет/yes/1/0 → boolean', () => {
    expect(c('Да', 'Edm.Boolean').value).toBe(true);
    expect(c('нет', 'Edm.Boolean').value).toBe(false);
    expect(c('YES', 'Edm.Boolean').value).toBe(true);
    expect(c(0, 'Edm.Boolean').value).toBe(false);
    expect(c('1', 'Edm.Boolean').value).toBe(true);
    expect(c(true, 'Edm.Boolean')).toEqual({ value: true, changed: false });
  });

  it('числа: пробелы, неразрывные пробелы и запятая', () => {
    expect(c('1 500,50', 'Edm.Decimal').value).toBe(1500.5);
    expect(c('1 500,50', 'Edm.Decimal').value).toBe(1500.5);
    expect(c('1 500', 'Edm.Int32').value).toBe(1500);
    expect(c('1.500,5', 'Edm.Double').value).toBe(1500.5);
    expect(c('1,500.5', 'Edm.Double').value).toBe(1500.5);
    expect(c('-3', 'Edm.Int64').value).toBe(-3);
    expect(c(42, 'Edm.Int32')).toEqual({ value: 42, changed: false });
  });

  it('пустая строка → null, null и неизвестные типы не трогаются', () => {
    expect(c('', 'Edm.DateTimeOffset')).toEqual({ value: null, changed: true });
    expect(c(null, 'Edm.Int32')).toEqual({ value: null, changed: false });
    expect(c('текст', 'Edm.String')).toEqual({ value: 'текст', changed: false });
    expect(c('abc', 'Edm.Guid')).toEqual({ value: 'abc', changed: false });
  });

  it('неразбираемое → ошибка с полем, значением и форматом', () => {
    expect(() => c('1,5', 'Edm.Int32')).toThrow(/F.*"1,5".*Edm\.Int32.*целое число/);
    expect(() => c('может быть', 'Edm.Boolean')).toThrow(/да\/нет/);
    expect(() => c('31.02.2026', 'Edm.Date')).toThrow(/Edm\.Date/);
    expect(() => c('на следующей неделе', 'Edm.DateTimeOffset', MSK)).toThrow(/25\.09\.2026 15:00/);
    expect(() => c('2026-09-25T25:00', 'Edm.DateTimeOffset', MSK)).toThrow();
    expect(() => c(12.5, 'Edm.Int32')).toThrow();
  });
});

describe('resolveDataLookups: приведение по типу колонки', () => {
  const cfg = { odata_version: 4, lookup_cache_ttl: 300 } as BpmConfig;
  const mm = {
    async getEntityMetadata() {
      return {
        properties: [
          { name: 'DueDate', type: 'Edm.DateTimeOffset', isLookup: false },
          { name: 'IsDone', type: 'Edm.Boolean', isLookup: false },
          { name: 'Amount', type: 'Edm.Decimal', isLookup: false },
          { name: 'Title', type: 'Edm.String', isLookup: false },
          { name: 'CityId', type: 'Edm.Guid', isLookup: true },
        ],
        lookupFields: [],
      };
    },
    async resolveFieldReference(_c: string, key: string) {
      return { name: key };
    },
    async getLookupInfo(_c: string, field: string) {
      return field === 'CityId' ? { lookupCollection: 'City', displayColumn: 'Name' } : null;
    },
  };

  it('приводит значения, пояс берёт один раз, lookup резолвит как раньше', async () => {
    const od = {
      async getRecords() {
        return { value: [{ Id: 'city-1', Name: 'Москва' }] };
      },
    };
    const currentUser = { get: vi.fn(async () => ({ timeZoneId: MSK })) };
    const resolver = new LookupResolver(cfg, od as never, mm as never, { currentUser: currentUser as never });
    const res = await resolver.resolveDataLookups('Activity', {
      DueDate: '25.09.2026 15:00',
      IsDone: 'нет',
      Amount: '1 500,50',
      Title: '25.09.2026',
      CityId: 'Москва',
    });
    expect(res.data).toEqual({
      DueDate: '2026-09-25T12:00:00Z',
      IsDone: false,
      Amount: 1500.5,
      Title: '25.09.2026',
      CityId: 'city-1',
    });
    expect(res.coerced).toEqual([
      {
        field: 'DueDate',
        input: '25.09.2026 15:00',
        output: '2026-09-25T12:00:00Z',
        type: 'Edm.DateTimeOffset',
      },
      { field: 'IsDone', input: 'нет', output: false, type: 'Edm.Boolean' },
      { field: 'Amount', input: '1 500,50', output: 1500.5, type: 'Edm.Decimal' },
    ]);
    expect(res.notes).toHaveLength(0);
    expect(currentUser.get).toHaveBeenCalledTimes(1);
  });
});
