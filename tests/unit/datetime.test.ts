import { describe, it, expect } from 'vitest';
import {
  calendarRange,
  describeNow,
  isValidTimeZone,
  resolveTimeZone,
  zonedMidnightUtc,
  zonedParts,
  zoneOffsetMinutes,
} from '../../src/utils/datetime.js';

const MSK = 'Europe/Moscow';

describe('часовой пояс', () => {
  it('валидирует зоны', () => {
    expect(isValidTimeZone(MSK)).toBe(true);
    expect(isValidTimeZone('Мордор/Барад-дур')).toBe(false);
  });

  it('явная зона побеждает окружение, неизвестная откатывается на пояс процесса', () => {
    expect(resolveTimeZone(MSK)).toBe(MSK);
    expect(isValidTimeZone(resolveTimeZone('Нет/Такой'))).toBe(true);
  });

  it('смещение Москвы — +3 часа круглый год (перевода часов нет)', () => {
    expect(zoneOffsetMinutes(new Date('2026-01-15T12:00:00Z'), MSK)).toBe(180);
    expect(zoneOffsetMinutes(new Date('2026-07-15T12:00:00Z'), MSK)).toBe(180);
  });

  it('переход на летнее время в Берлине виден в смещении', () => {
    expect(zoneOffsetMinutes(new Date('2026-01-15T12:00:00Z'), 'Europe/Berlin')).toBe(60);
    expect(zoneOffsetMinutes(new Date('2026-07-15T12:00:00Z'), 'Europe/Berlin')).toBe(120);
  });
});

describe('границы суток', () => {
  it('полночь по Москве — это 21:00 предыдущего дня UTC', () => {
    const midnight = zonedMidnightUtc(2026, 9, 7, MSK);
    expect(midnight.toISOString()).toBe('2026-09-06T21:00:00.000Z');
  });

  it('момент 01:00 по Москве принадлежит уже наступившим суткам, хотя в UTC ещё вчера', () => {
    const instant = new Date('2026-09-06T22:00:00Z'); // 01:00 07.09 по Москве
    const parts = zonedParts(instant, MSK);
    expect([parts.year, parts.month, parts.day]).toEqual([2026, 9, 7]);
    expect(parts.hour).toBe(1);

    const today = calendarRange('today', MSK, instant);
    expect(instant >= today.from && instant < today.to).toBe(true);
  });
});

describe('календарные периоды', () => {
  const now = new Date('2026-09-07T09:00:00Z'); // понедельник, 12:00 по Москве

  it('сегодня — полусегмент от полуночи до полуночи', () => {
    const r = calendarRange('today', MSK, now);
    expect(r.from.toISOString()).toBe('2026-09-06T21:00:00.000Z');
    expect(r.to.toISOString()).toBe('2026-09-07T21:00:00.000Z');
  });

  it('вчера и завтра примыкают к сегодня без зазоров', () => {
    const yesterday = calendarRange('yesterday', MSK, now);
    const today = calendarRange('today', MSK, now);
    const tomorrow = calendarRange('tomorrow', MSK, now);
    expect(yesterday.to.getTime()).toBe(today.from.getTime());
    expect(today.to.getTime()).toBe(tomorrow.from.getTime());
  });

  it('неделя начинается с понедельника', () => {
    const week = calendarRange('this_week', MSK, now);
    // 07.09.2026 — понедельник, значит неделя стартует этим же днём
    expect(week.from.toISOString()).toBe('2026-09-06T21:00:00.000Z');
    expect(Math.round((week.to.getTime() - week.from.getTime()) / 86400000)).toBe(7);
  });

  it('месяц, квартал и год считаются по календарю пояса', () => {
    const month = calendarRange('this_month', MSK, now);
    expect(month.from.toISOString()).toBe('2026-08-31T21:00:00.000Z');
    expect(month.to.toISOString()).toBe('2026-09-30T21:00:00.000Z');

    const quarter = calendarRange('this_quarter', MSK, now);
    expect(quarter.from.toISOString()).toBe('2026-06-30T21:00:00.000Z');

    const year = calendarRange('this_year', MSK, now);
    expect(year.from.toISOString()).toBe('2025-12-31T21:00:00.000Z');
    expect(year.to.toISOString()).toBe('2026-12-31T21:00:00.000Z');
  });

  it('декабрь не уезжает в тринадцатый месяц', () => {
    const december = new Date('2026-12-15T09:00:00Z');
    const month = calendarRange('this_month', MSK, december);
    expect(month.to.toISOString()).toBe('2026-12-31T21:00:00.000Z');
  });

  it('в январе прошлый месяц — декабрь прошлого года', () => {
    const january = new Date('2026-01-15T09:00:00Z');
    const previous = calendarRange('last_month', MSK, january);
    expect(previous.from.toISOString()).toBe('2025-11-30T21:00:00.000Z');
    expect(previous.to.toISOString()).toBe('2025-12-31T21:00:00.000Z');
  });
});

describe('describeNow', () => {
  it('отдаёт и UTC, и локальное время с подписью пояса', () => {
    const now = describeNow(MSK, new Date('2026-09-07T09:00:00Z'));
    expect(now.utc).toBe('2026-09-07T09:00:00Z');
    expect(now.local).toBe('2026-09-07T12:00');
    expect(now.date).toBe('2026-09-07');
    expect(now.offset).toBe('+03:00');
    expect(now.timezone).toBe(MSK);
    expect(now.weekday).toBe('понедельник');
  });
});
