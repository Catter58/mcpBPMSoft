/**
 * Календарные периоды в часовом поясе пользователя.
 *
 * «Сегодня» — не `Date.now()`: BPMSoft хранит время в UTC, а пользователь живёт
 * в своём поясе, и граница суток у них разная. Для московского пользователя
 * задача «на сегодня» в 01:00 по Москве попадает во вчерашний день UTC — без
 * учёта пояса фильтр промахнётся на целые сутки.
 *
 * Пояс берётся в порядке: явный аргумент → `BPMSOFT_TIMEZONE` → пояс процесса.
 * Смещение считается через `Intl.DateTimeFormat` с `timeZone`, поэтому переход
 * на летнее время учитывается сам собой и без внешних зависимостей.
 */

export interface DateRange {
  /** Включительно */
  from: Date;
  /** Исключительно (полночь следующего периода) */
  to: Date;
}

/** Календарные периоды, понятные без объяснений. */
export type CalendarPeriod =
  | 'today'
  | 'yesterday'
  | 'tomorrow'
  | 'this_week'
  | 'last_week'
  | 'this_month'
  | 'last_month'
  | 'this_quarter'
  | 'this_year';

/** Часовой пояс, в котором сервер считает «сегодня». */
export function resolveTimeZone(explicit?: string): string {
  const candidate = explicit || process.env.BPMSOFT_TIMEZONE;
  if (candidate && isValidTimeZone(candidate)) return candidate;
  if (candidate) {
    console.error(`[datetime] Неизвестный часовой пояс "${candidate}", беру пояс процесса`);
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/** Смещение пояса от UTC в минутах на конкретный момент (с учётом DST). */
export function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  // Приём без зависимостей: форматируем момент как «локальное» время зоны и
  // сравниваем с тем же моментом в UTC.
  const asUtc = new Date(instant.toLocaleString('en-US', { timeZone: 'UTC' }));
  const asZone = new Date(instant.toLocaleString('en-US', { timeZone }));
  return Math.round((asZone.getTime() - asUtc.getTime()) / 60000);
}

/** Компоненты календарной даты в поясе (год/месяц/день/часы/минуты). */
export function zonedParts(
  instant: Date,
  timeZone: string
): { year: number; month: number; day: number; hour: number; minute: number; weekday: number } {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  const parts = Object.fromEntries(formatter.formatToParts(instant).map((p) => [p.type, p.value]));
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour === '24' ? '0' : parts.hour),
    minute: Number(parts.minute),
    weekday: Math.max(0, weekdays.indexOf(String(parts.weekday))),
  };
}

/** UTC-момент полуночи указанной календарной даты в поясе. */
export function zonedMidnightUtc(year: number, month: number, day: number, timeZone: string): Date {
  // Первое приближение — полночь как будто в UTC, затем поправка на смещение
  // именно этого момента (иначе на границе перевода часов промахиваемся на час).
  const guess = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  const offset = zoneOffsetMinutes(guess, timeZone);
  const corrected = new Date(guess.getTime() - offset * 60000);
  const refined = zoneOffsetMinutes(corrected, timeZone);
  return refined === offset ? corrected : new Date(guess.getTime() - refined * 60000);
}

/**
 * Границы календарного периода в UTC. Верхняя граница исключающая, поэтому
 * фильтр строится как `field ge from and field lt to` и не теряет последнюю
 * секунду суток.
 */
export function calendarRange(period: CalendarPeriod, timeZone: string, now: Date = new Date()): DateRange {
  const today = zonedParts(now, timeZone);
  const midnight = (y: number, m: number, d: number) => zonedMidnightUtc(y, m, d, timeZone);
  const shiftDays = (base: Date, days: number) => {
    const parts = zonedParts(new Date(base.getTime() + days * 86400000), timeZone);
    return midnight(parts.year, parts.month, parts.day);
  };

  const startOfToday = midnight(today.year, today.month, today.day);

  switch (period) {
    case 'today':
      return { from: startOfToday, to: shiftDays(startOfToday, 1) };
    case 'yesterday':
      return { from: shiftDays(startOfToday, -1), to: startOfToday };
    case 'tomorrow':
      return { from: shiftDays(startOfToday, 1), to: shiftDays(startOfToday, 2) };
    case 'this_week': {
      // Неделя с понедельника — так считают в русскоязычном контексте.
      const backToMonday = (today.weekday + 6) % 7;
      const from = shiftDays(startOfToday, -backToMonday);
      return { from, to: shiftDays(from, 7) };
    }
    case 'last_week': {
      const backToMonday = (today.weekday + 6) % 7;
      const thisMonday = shiftDays(startOfToday, -backToMonday);
      return { from: shiftDays(thisMonday, -7), to: thisMonday };
    }
    case 'this_month':
      return {
        from: midnight(today.year, today.month, 1),
        to: today.month === 12 ? midnight(today.year + 1, 1, 1) : midnight(today.year, today.month + 1, 1),
      };
    case 'last_month':
      return {
        from: today.month === 1 ? midnight(today.year - 1, 12, 1) : midnight(today.year, today.month - 1, 1),
        to: midnight(today.year, today.month, 1),
      };
    case 'this_quarter': {
      const quarterStart = Math.floor((today.month - 1) / 3) * 3 + 1;
      return {
        from: midnight(today.year, quarterStart, 1),
        to:
          quarterStart + 3 > 12 ? midnight(today.year + 1, 1, 1) : midnight(today.year, quarterStart + 3, 1),
      };
    }
    case 'this_year':
      return { from: midnight(today.year, 1, 1), to: midnight(today.year + 1, 1, 1) };
  }
}

/** Человекочитаемая сводка «который сейчас час» для ответа модели. */
export function describeNow(
  timeZone: string,
  now: Date = new Date()
): { utc: string; local: string; timezone: string; offset: string; date: string; weekday: string } {
  const offsetMinutes = zoneOffsetMinutes(now, timeZone);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const parts = zonedParts(now, timeZone);
  const pad = (n: number) => String(n).padStart(2, '0');
  const weekday = new Intl.DateTimeFormat('ru-RU', { timeZone, weekday: 'long' }).format(now);

  return {
    utc: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    local: `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`,
    timezone: timeZone,
    offset: `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`,
    date: `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`,
    weekday,
  };
}
