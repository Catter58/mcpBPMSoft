/**
 * Приведение значений записи к EDM-типу колонки на write-пути.
 *
 * Модель пишет так, как говорит человек: «25.09.2026 15:00», «да», «1 500,50».
 * BPMSoft ждёт ISO-момент с поясом, boolean и число. Приводит сервер — по типу
 * колонки из $metadata, а не модель. Уже корректные значения не трогаются;
 * неразбираемые — понятная ошибка с именем поля и ожидаемым форматом.
 */

import { coerceFieldValue } from './field-values.js';
import { BpmApiError } from './errors.js';
import { calendarRange, resolveTimeZone, zoneOffsetMinutes, zonedParts } from './datetime.js';

/** Пометка о приведённом значении: что пришло и что ушло в BPMSoft. */
export interface CoercedValueNote {
  field: string;
  input: unknown;
  output: unknown;
  type: string;
}

export interface CoerceOptions {
  /** Frozen operation time for relative calendar expressions. */
  now?: Date;
  /** Local hour used when a DateTime value contains a date but no time. */
  defaultHour?: number;
}

const INT_TYPES = new Set(['Edm.Int16', 'Edm.Int32', 'Edm.Int64', 'Edm.Byte', 'Edm.SByte']);
const FLOAT_TYPES = new Set(['Edm.Decimal', 'Edm.Double', 'Edm.Single']);
const DATETIME_TYPE = 'Edm.DateTimeOffset';
const DATE_TYPE = 'Edm.Date';
const BOOL_TYPE = 'Edm.Boolean';

const TRUE_WORDS = new Set(['да', 'true', '1', 'yes', 'y', 'истина']);
const FALSE_WORDS = new Set(['нет', 'false', '0', 'no', 'n', 'ложь']);
const RELATIVE_DAYS: Record<string, 'today' | 'tomorrow' | 'yesterday'> = {
  сегодня: 'today',
  завтра: 'tomorrow',
  вчера: 'yesterday',
  today: 'today',
  tomorrow: 'tomorrow',
  yesterday: 'yesterday',
  послезавтра: 'tomorrow',
};

const ISO_WITH_OFFSET_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;
const ISO_LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?$/;
const RU_DATE_RE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
const RELATIVE_RE = /^(\S+)(?:\s+(?:в\s+)?(\d{1,2}):(\d{2}))?$/i;

/** True when a supported datetime phrase names a calendar day but no clock time. */
export function isCalendarDateOnly(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text) return false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text) || /^\d{1,2}\.\d{1,2}\.\d{4}$/.test(text)) return true;
  if (/^(сегодня|завтра|послезавтра|вчера|today|tomorrow|yesterday)$/i.test(text)) return true;
  return /^через\s+\d{1,5}\s+д(?:ень|ня|ней)$/i.test(text);
}

/** Нужен ли для приведения часовой пояс пользователя (чтобы не ходить за ним зря). */
export function needsTimeZone(value: unknown, edmType: string): boolean {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (ISO_WITH_OFFSET_RE.test(text)) return false;
  if (edmType !== DATETIME_TYPE && edmType !== 'Edm.DateTime' && edmType !== DATE_TYPE) return false;
  const relative = text.match(RELATIVE_RE);
  const isRelative = Boolean(relative && RELATIVE_DAYS[relative[1].toLowerCase()]);
  const duration = text.match(/^через\s+\d{1,5}\s+(мин(?:ут(?:а|ы)?)?|час(?:а|ов)?|д(?:ень|ня|ней))$/i);
  const isCalendarDuration = Boolean(duration && duration[1].toLowerCase().startsWith('д'));
  if (edmType === DATE_TYPE) return isRelative;
  // A calendar date without a clock is local for DateTimeOffset, while a
  // date-only Edm.Date is just a calendar value and needs no timezone.
  return isRelative || isCalendarDuration || ISO_LOCAL_RE.test(text) || RU_DATE_RE.test(text);
}

/**
 * Приводит значение к типу колонки. Возвращает `changed=false`, если значение уже
 * в нужной форме или тип не требует приведения (строки, Guid и прочее).
 */
export function coerceValue(
  field: string,
  value: unknown,
  edmType: string,
  timeZone?: string,
  options: CoerceOptions = {}
): { value: unknown; changed: boolean } {
  if (value === null || value === undefined) return { value, changed: false };
  const known =
    edmType === DATETIME_TYPE ||
    edmType === 'Edm.DateTime' ||
    edmType === DATE_TYPE ||
    edmType === BOOL_TYPE ||
    INT_TYPES.has(edmType) ||
    FLOAT_TYPES.has(edmType);
  if (!known) return { value, changed: false };

  // Пустая строка в типизированной колонке — «очистить», как и в lookup-полях.
  if (typeof value === 'string' && value.trim() === '') return { value: null, changed: true };

  let out: unknown;
  if (edmType === BOOL_TYPE) out = toBoolean(value);
  else if (INT_TYPES.has(edmType) || FLOAT_TYPES.has(edmType)) {
    const normalized = normalizeNumber(value);
    if (normalized !== undefined)
      out = coerceFieldValue(normalized, {
        name: field,
        type: edmType,
        nullable: true,
        isLookup: false,
      });
  } else if (edmType === DATE_TYPE) out = toDate(value, timeZone, options.now);
  else out = toDateTimeOffset(value, timeZone, options.now, options.defaultHour ?? 12);

  if (out === undefined) throw coercionError(field, value, edmType);
  return { value: out, changed: out !== value };
}

function toBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  if (TRUE_WORDS.has(s)) return true;
  if (FALSE_WORDS.has(s)) return false;
  return undefined;
}

function normalizeNumber(value: unknown): string | number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return undefined;
  let text = value.replace(/[\s']/g, '');
  const comma = text.lastIndexOf(',');
  const dot = text.lastIndexOf('.');
  if (comma > dot) text = text.replace(/\./g, '').replace(',', '.');
  else if (dot > comma && comma !== -1) text = text.replace(/,/g, '');
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text) ? text : undefined;
}

function toDate(value: unknown, timeZone?: string, now: Date = new Date()): string | undefined {
  if (typeof value !== 'string') return undefined;
  const s = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s))
    return validYmd(+s.slice(0, 4), +s.slice(5, 7), +s.slice(8, 10)) ? s : undefined;
  const ru = s.match(RU_DATE_RE);
  if (ru && ru[4] === undefined) return ymd(+ru[3], +ru[2], +ru[1]);
  const rel = s.match(RELATIVE_RE);
  const phrase = rel && rel[2] === undefined ? rel[1].toLowerCase() : undefined;
  const period = phrase ? RELATIVE_DAYS[phrase] : undefined;
  if (!period) return undefined;
  const tz = resolveTimeZone(timeZone);
  return phrase === 'послезавтра' ? relativeDayAfterTomorrow(tz, now) : relativeDay(period, tz, now);
}

function toDateTimeOffset(
  value: unknown,
  timeZone?: string,
  now: Date = new Date(),
  defaultHour = 12
): string | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : isoZ(value);
  if (typeof value !== 'string') return undefined;
  const s = value.trim();
  if (/^(сейчас|now)$/i.test(s)) return isoZ(now);
  const duration = s.match(/^через\s+(\d{1,5})\s+(мин(?:ут(?:а|ы)?)?|час(?:а|ов)?|д(?:ень|ня|ней))$/i);
  if (duration) {
    const amount = Number(duration[1]);
    const unit = duration[2].toLowerCase();
    const max = unit.startsWith('м') ? 10_080 : unit.startsWith('ч') ? 168 : 365;
    if (amount < 1 || amount > max) return undefined;
    if (unit.startsWith('д')) {
      const tz = resolveTimeZone(timeZone);
      const today = zonedParts(calendarRange('today', tz, now).from, tz);
      const target = new Date(Date.UTC(today.year, today.month - 1, today.day + amount));
      return localToUtc(
        target.getUTCFullYear(),
        target.getUTCMonth() + 1,
        target.getUTCDate(),
        defaultHour,
        0,
        0,
        tz
      );
    }
    const multiplier = unit.startsWith('м') ? 60_000 : 3_600_000;
    return isoZ(new Date(now.getTime() + amount * multiplier));
  }
  if (ISO_WITH_OFFSET_RE.test(s)) {
    try {
      coerceFieldValue(s, { name: 'date', type: 'Edm.DateTimeOffset', nullable: false, isLookup: false });
    } catch {
      return undefined;
    }
    return value;
  }

  const tz = resolveTimeZone(timeZone);
  const iso = s.match(ISO_LOCAL_RE);
  if (iso)
    return localToUtc(
      +iso[1],
      +iso[2],
      +iso[3],
      +(iso[4] ?? defaultHour),
      +(iso[5] ?? 0),
      +(iso[6] ?? 0),
      tz
    );
  const ru = s.match(RU_DATE_RE);
  if (ru)
    return localToUtc(+ru[3], +ru[2], +ru[1], +(ru[4] ?? defaultHour), +(ru[5] ?? 0), +(ru[6] ?? 0), tz);
  const rel = s.match(RELATIVE_RE);
  const period = rel ? RELATIVE_DAYS[rel[1].toLowerCase()] : undefined;
  if (rel && period) {
    const day =
      rel[1].toLowerCase() === 'послезавтра'
        ? relativeDayAfterTomorrow(tz, now)
        : relativeDay(period, tz, now);
    const [y, m, d] = day.split('-').map(Number);
    return localToUtc(y, m, d, +(rel[2] ?? defaultHour), +(rel[3] ?? 0), 0, tz);
  }
  return undefined;
}

/** «сегодня»/«завтра»/«вчера» в поясе → 'YYYY-MM-DD'. */
function relativeDay(period: 'today' | 'tomorrow' | 'yesterday', tz: string, now: Date = new Date()): string {
  // Полночь в поясе + 12 ч гарантированно лежит внутри нужных суток.
  const noon = new Date(calendarRange(period, tz, now).from.getTime() + 12 * 3600000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(noon);
}

function relativeDayAfterTomorrow(tz: string, now: Date): string {
  const range = calendarRange('tomorrow', tz, now);
  const instant = new Date(range.to.getTime() + 12 * 3600000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(instant);
}

/** Местное время пояса → UTC ISO с Z; смещение уточняется на сам момент (DST). */
export function localToUtc(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  sec: number,
  tz: string,
  millisecond = 0
): string | undefined {
  if (!validYmd(y, mo, d) || h > 23 || mi > 59 || sec > 59 || millisecond < 0 || millisecond > 999)
    return undefined;
  const guess = Date.UTC(y, mo - 1, d, h, mi, sec, millisecond);
  // Try nearby offsets and retain only instants that map back to the exact
  // requested wall clock. Gaps and folds are ambiguous, so reject both.
  const offsets = new Set<number>();
  for (let delta = -36; delta <= 36; delta += 6)
    offsets.add(zoneOffsetMinutes(new Date(guess + delta * 3600000), tz));
  const matches = [...offsets]
    .map((offset) => guess - offset * 60000)
    .filter((instant) => {
      const p = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).formatToParts(new Date(instant));
      const values = Object.fromEntries(p.map((part) => [part.type, part.value]));
      return (
        +values.year === y &&
        +values.month === mo &&
        +values.day === d &&
        +(values.hour === '24' ? '0' : values.hour) === h &&
        +values.minute === mi &&
        +values.second === sec
      );
    });
  return matches.length === 1 ? isoZ(new Date(matches[0])) : undefined;
}

function validYmd(y: number, m: number, d: number): boolean {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function ymd(y: number, m: number, d: number): string | undefined {
  if (!validYmd(y, m, d)) return undefined;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function isoZ(date: Date): string {
  return date.toISOString().replace(/\.000Z$/, 'Z');
}

const EXPECTED: Record<string, string> = {
  [DATETIME_TYPE]:
    'дата и время: "2026-09-25T15:00", "25.09.2026 15:00", "сегодня"/"завтра" или ISO со смещением "2026-09-25T15:00:00+03:00"',
  [DATE_TYPE]: 'дата: "2026-09-25" или "25.09.2026"',
  [BOOL_TYPE]: 'логическое: true/false, да/нет, 1/0',
};

function coercionError(field: string, value: unknown, edmType: string): BpmApiError {
  const expected =
    EXPECTED[edmType] ??
    (INT_TYPES.has(edmType) ? 'целое число, например 1500' : 'число, например 1500.5 или "1 500,50"');
  return new BpmApiError(
    `Поле ${field}: значение ${JSON.stringify(value)} не подходит под тип ${edmType}. Ожидается ${expected}.`,
    400,
    undefined,
    undefined,
    undefined,
    [`Повторите вызов, передав в ${field} ${expected}.`]
  );
}

/** Строка для ответа модели: какие значения сервер привёл к типу колонки. */
export function coercedText(notes: CoercedValueNote[] | undefined): string | null {
  if (!notes || notes.length === 0) return null;
  const parts = notes.map((n) => `${n.field}: ${JSON.stringify(n.input)} → ${JSON.stringify(n.output)}`);
  return `Приведены значения: ${parts.join('; ')}`;
}
