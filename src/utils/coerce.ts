/**
 * Приведение значений записи к EDM-типу колонки на write-пути.
 *
 * Модель пишет так, как говорит человек: «25.09.2026 15:00», «да», «1 500,50».
 * BPMSoft ждёт ISO-момент с поясом, boolean и число. Приводит сервер — по типу
 * колонки из $metadata, а не модель. Уже корректные значения не трогаются;
 * неразбираемые — понятная ошибка с именем поля и ожидаемым форматом.
 */

import { BpmApiError } from './errors.js';
import { calendarRange, resolveTimeZone, zoneOffsetMinutes } from './datetime.js';

/** Пометка о приведённом значении: что пришло и что ушло в BPMSoft. */
export interface CoercedValueNote {
  field: string;
  input: unknown;
  output: unknown;
  type: string;
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
};

const ISO_WITH_OFFSET_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;
const ISO_LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?$/;
const RU_DATE_RE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
const RELATIVE_RE = /^(\S+)(?:\s+(?:в\s+)?(\d{1,2}):(\d{2}))?$/i;

/** Нужен ли для приведения часовой пояс пользователя (чтобы не ходить за ним зря). */
export function needsTimeZone(value: unknown, edmType: string): boolean {
  return (
    typeof value === 'string' &&
    (edmType === DATETIME_TYPE || edmType === DATE_TYPE) &&
    !ISO_WITH_OFFSET_RE.test(value.trim())
  );
}

/**
 * Приводит значение к типу колонки. Возвращает `changed=false`, если значение уже
 * в нужной форме или тип не требует приведения (строки, Guid и прочее).
 */
export function coerceValue(
  field: string,
  value: unknown,
  edmType: string,
  timeZone?: string
): { value: unknown; changed: boolean } {
  if (value === null || value === undefined) return { value, changed: false };
  const known =
    edmType === DATETIME_TYPE ||
    edmType === DATE_TYPE ||
    edmType === BOOL_TYPE ||
    INT_TYPES.has(edmType) ||
    FLOAT_TYPES.has(edmType);
  if (!known) return { value, changed: false };

  // Пустая строка в типизированной колонке — «очистить», как и в lookup-полях.
  if (typeof value === 'string' && value.trim() === '') return { value: null, changed: true };

  let out: unknown;
  if (edmType === BOOL_TYPE) out = toBoolean(value);
  else if (INT_TYPES.has(edmType)) out = toNumber(value, true);
  else if (FLOAT_TYPES.has(edmType)) out = toNumber(value, false);
  else if (edmType === DATE_TYPE) out = toDate(value, timeZone);
  else out = toDateTimeOffset(value, timeZone);

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

function toNumber(value: unknown, integral: boolean): number | undefined {
  let n: number;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string') {
    // \s в JS покрывает и неразрывные пробелы (U+00A0, U+202F) — разделители тысяч.
    let s = value.replace(/[\s']/g, '');
    const comma = s.lastIndexOf(',');
    const dot = s.lastIndexOf('.');
    // Десятичный — последний из разделителей, второй считается разделителем тысяч.
    if (comma > dot) s = s.replace(/\./g, '').replace(',', '.');
    else if (dot > comma && comma !== -1) s = s.replace(/,/g, '');
    if (!/^[+-]?\d+(\.\d+)?$/.test(s)) return undefined;
    n = Number(s);
  } else {
    return undefined;
  }
  if (!Number.isFinite(n) || (integral && !Number.isInteger(n))) return undefined;
  return n;
}

function toDate(value: unknown, timeZone?: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  const s = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s))
    return validYmd(+s.slice(0, 4), +s.slice(5, 7), +s.slice(8, 10)) ? s : undefined;
  const ru = s.match(RU_DATE_RE);
  if (ru && ru[4] === undefined) return ymd(+ru[3], +ru[2], +ru[1]);
  const rel = s.match(RELATIVE_RE);
  const period = rel && rel[2] === undefined ? RELATIVE_DAYS[rel[1].toLowerCase()] : undefined;
  return period ? relativeDay(period, resolveTimeZone(timeZone)) : undefined;
}

function toDateTimeOffset(value: unknown, timeZone?: string): string | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : isoZ(value);
  if (typeof value !== 'string') return undefined;
  const s = value.trim();
  if (ISO_WITH_OFFSET_RE.test(s)) return Number.isNaN(Date.parse(s)) ? undefined : value;

  const tz = resolveTimeZone(timeZone);
  const iso = s.match(ISO_LOCAL_RE);
  if (iso) return localToUtc(+iso[1], +iso[2], +iso[3], +(iso[4] ?? 0), +(iso[5] ?? 0), +(iso[6] ?? 0), tz);
  const ru = s.match(RU_DATE_RE);
  if (ru) return localToUtc(+ru[3], +ru[2], +ru[1], +(ru[4] ?? 0), +(ru[5] ?? 0), +(ru[6] ?? 0), tz);
  const rel = s.match(RELATIVE_RE);
  const period = rel ? RELATIVE_DAYS[rel[1].toLowerCase()] : undefined;
  if (rel && period) {
    const [y, m, d] = relativeDay(period, tz).split('-').map(Number);
    return localToUtc(y, m, d, +(rel[2] ?? 0), +(rel[3] ?? 0), 0, tz);
  }
  return undefined;
}

/** «сегодня»/«завтра»/«вчера» в поясе → 'YYYY-MM-DD'. */
function relativeDay(period: 'today' | 'tomorrow' | 'yesterday', tz: string): string {
  // Полночь в поясе + 12 ч гарантированно лежит внутри нужных суток.
  const noon = new Date(calendarRange(period, tz).from.getTime() + 12 * 3600000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(noon);
}

/** Местное время пояса → UTC ISO с Z; смещение уточняется на сам момент (DST). */
function localToUtc(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  sec: number,
  tz: string
): string | undefined {
  if (!validYmd(y, mo, d) || h > 23 || mi > 59 || sec > 59) return undefined;
  const guess = Date.UTC(y, mo - 1, d, h, mi, sec);
  const offset = zoneOffsetMinutes(new Date(guess), tz);
  const corrected = guess - offset * 60000;
  const refined = zoneOffsetMinutes(new Date(corrected), tz);
  return isoZ(new Date(refined === offset ? corrected : guess - refined * 60000));
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
