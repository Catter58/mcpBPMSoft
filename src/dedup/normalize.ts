/**
 * Нормализация полей для поиска дублей: ФИО, названия, e-mail, телефоны, ИНН, домены,
 * транслитерация и оценка похожести имён.
 */

import { normalizeName } from '../utils/name-normalize.js';
import type { DedupKind } from './types.js';

/** Всё, что не буква и не цифра, — в пробел (кавычки, точки, запятые, дефисы). */
const NON_WORD_RE = /[^\p{L}\p{N}]+/gu;

/** Орг-формы, которых нет в utils/name-normalize.ts. */
const EXTRA_ORG_FORMS = new Set(['гк', 'нао', 'ано', 'limited', 'plc', 'ag', 'sa', 'oy', 'ab', 'bv', 'srl']);

const FREE_MAIL_DOMAINS = new Set([
  'mail.ru',
  'inbox.ru',
  'list.ru',
  'bk.ru',
  'internet.ru',
  'yandex.ru',
  'ya.ru',
  'yandex.com',
  'rambler.ru',
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
  'icloud.com',
  'me.com',
  'proton.me',
  'protonmail.com',
  'aol.com',
]);

const TRANSLIT: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'kh',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'shch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};

function cleanText(value: string): string {
  return value.toLowerCase().replace(/ё/g, 'е').replace(NON_WORD_RE, ' ').replace(/\s+/g, ' ').trim();
}

/** 'Иванов Иван Иванович' / 'Иван Иванович ИВАНОВ' → 'иван иванов иванович' (токены отсортированы). */
export function normalizePersonName(value: string): string {
  const cleaned = cleanText(value);
  return cleaned ? cleaned.split(' ').sort().join(' ') : '';
}

/** 'ООО «Ромашка»' / 'Ромашка, ООО' → 'ромашка'. Пустое ядро (только орг-форма) — оставляем как есть. */
export function normalizeOrgName(value: string): string {
  const tokens = normalizeName(cleanText(value)).tokens;
  let start = 0;
  let end = tokens.length;
  while (start < end && EXTRA_ORG_FORMS.has(tokens[start])) start++;
  while (end > start && EXTRA_ORG_FORMS.has(tokens[end - 1])) end--;
  return (end > start ? tokens.slice(start, end) : tokens).join(' ');
}

/** Нормализация по виду записи; generic — без удаления орг-форм. */
export function normalizeByKind(value: string, kind: DedupKind): string {
  if (kind === 'person') return normalizePersonName(value);
  if (kind === 'organization') return normalizeOrgName(value);
  return cleanText(value);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return null;
  const at = email.lastIndexOf('@');
  let local = email.slice(0, at);
  let domain = email.slice(at + 1);
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    local = local.split('+')[0].replace(/\./g, '');
    domain = 'gmail.com';
    if (!local) return null;
  }
  return `${local}@${domain}`;
}

/** Цифры; российские 8/7/+7 и любые номера от 10 цифр → последние 10; короче 7 цифр → null. */
export function normalizePhone(value: string): string | null {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 7) return null;
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

/** Только длина 10 или 12; контрольные разряды не проверяем (ИНН с опечаткой всё равно идентифицирует). */
export function normalizeInn(value: string): string | null {
  const digits = value.replace(/\D/g, '');
  if (digits.length !== 10 && digits.length !== 12) return null;
  return /^0+$/.test(digits) ? null : digits;
}

export function normalizeDomain(value: string): string | null {
  const host = value
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^[^@/]*@/, '')
    .split(/[/?#]/)[0]
    .replace(/:\d+$/, '')
    .replace(/^www\./, '')
    .replace(/\.$/, '');
  if (!/^[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)+$/u.test(host)) return null;
  return FREE_MAIL_DOMAINS.has(host) ? null : host;
}

export function transliterate(value: string): string {
  let out = '';
  for (const ch of value) {
    const lower = ch.toLowerCase();
    const mapped = TRANSLIT[lower];
    if (mapped === undefined) out += ch;
    else out += ch === lower ? mapped : mapped.charAt(0).toUpperCase() + mapped.slice(1);
  }
  return out;
}

/**
 * Латинский «звуковой» ключ: транслит + сглаживание вариантов записи
 * (kh/h, x/ks, y/j/i, удвоенные буквы). 'Алексей' и 'Alexey' → 'aleksei'.
 */
export function latinKey(value: string): string {
  return transliterate(value.toLowerCase())
    .replace(/shch|sch/g, 'sh')
    .replace(/kh/g, 'h')
    .replace(/x/g, 'ks')
    .replace(/ph/g, 'f')
    .replace(/w/g, 'v')
    .replace(/ck/g, 'k')
    .replace(/[yj]/g, 'i')
    .replace(/(\p{L})\1+/gu, '$1');
}

/** Jaro-Winkler, 0..1. */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return a.length > 0 ? 1 : 0;
  if (!a || !b) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aHit = new Array<boolean>(a.length).fill(false);
  const bHit = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - range);
    const hi = Math.min(b.length - 1, i + range);
    for (let j = lo; j <= hi; j++) {
      if (!bHit[j] && a[i] === b[j]) {
        aHit[i] = true;
        bHit[j] = true;
        matches++;
        break;
      }
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aHit[i]) continue;
    while (!bHit[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

export interface NameToken {
  key: string;
  initial: boolean;
}

/** Токены ФИО в латинском ключе; однобуквенный исходный токен — инициал. */
export function personTokens(value: string): NameToken[] {
  const normalized = normalizePersonName(value);
  if (!normalized) return [];
  return normalized.split(' ').map((t) => ({ key: latinKey(t), initial: t.length === 1 }));
}

const TOKEN_FUZZY_MIN = 0.88;
const INITIAL_SCORE = 0.9;
/** Штраф за «лишний» токен у более длинного ФИО: 'Иванов Иван' vs 'Иванов Иван Иванович' ≈ 0.89. */
const EXTRA_TOKEN_PENALTY = 0.25;

/** Похожесть ФИО по заранее подготовленным токенам (см. personTokens). */
export function personSimilarity(a: NameToken[], b: NameToken[]): number {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length === 0) return 0;
  const used = new Array<boolean>(long.length).fill(false);
  const done = new Array<boolean>(short.length).fill(false);
  let sum = 0;
  let fullMatches = 0;

  // Проход 1: точные совпадения полных токенов.
  short.forEach((s, i) => {
    if (s.initial) return;
    const j = long.findIndex((l, idx) => !used[idx] && !l.initial && l.key === s.key);
    if (j >= 0) {
      used[j] = done[i] = true;
      sum += 1;
      fullMatches++;
    }
  });
  // Проход 2: опечатки (Jaro-Winkler) среди полных токенов.
  short.forEach((s, i) => {
    if (done[i] || s.initial || s.key.length < 3) return;
    let best = -1;
    let bestScore = TOKEN_FUZZY_MIN;
    long.forEach((l, idx) => {
      if (used[idx] || l.initial || l.key.length < 3) return;
      const score = jaroWinkler(s.key, l.key);
      if (score >= bestScore) {
        best = idx;
        bestScore = score;
      }
    });
    if (best >= 0) {
      used[best] = done[i] = true;
      sum += bestScore;
      fullMatches++;
    }
  });
  // Проход 3: инициалы ('и' ~ 'иван').
  short.forEach((s, i) => {
    if (done[i]) return;
    const j = long.findIndex(
      (l, idx) =>
        !used[idx] && (s.initial || l.initial) && (l.key.startsWith(s.key) || s.key.startsWith(l.key))
    );
    if (j >= 0) {
      used[j] = done[i] = true;
      sum += INITIAL_SCORE;
    }
  });

  if (fullMatches === 0) return 0;
  return sum / (short.length + EXTRA_TOKEN_PENALTY * (long.length - short.length));
}

/** Латинские токены названия (для orgSimilarity). */
export function textTokens(value: string, kind: DedupKind): string[] {
  return normalizeByKind(value, kind).split(' ').filter(Boolean).map(latinKey);
}

/** Похожесть названий по латинским токенам: max(JW подряд, JW по отсортированным токенам). */
export function textSimilarity(ta: string[], tb: string[]): number {
  if (ta.length === 0 || tb.length === 0) return 0;
  const direct = jaroWinkler(ta.join(''), tb.join(''));
  const sorted = jaroWinkler([...ta].sort().join(''), [...tb].sort().join(''));
  return Math.max(direct, sorted);
}

/**
 * Похожесть имён 0..1.
 * person: множество токенов с поддержкой инициалов и опечаток, нужен хотя бы один полный токен;
 * organization/generic: нормализация + транслит + Jaro-Winkler (прямой и по отсортированным токенам).
 */
export function nameSimilarity(a: string, b: string, kind: DedupKind): number {
  if (kind === 'person') return personSimilarity(personTokens(a), personTokens(b));
  return textSimilarity(textTokens(a, kind), textTokens(b, kind));
}
