/**
 * String similarity helpers — used for "did you mean?" suggestions
 * in tool errors when an LLM passes a slightly wrong field name or
 * caption.
 *
 * Levenshtein distance (iterative DP, O(m*n) time, O(min(m,n)) space).
 */

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Make sure b is the shorter for memory savings
  if (a.length < b.length) {
    const tmp = a;
    a = b;
    b = tmp;
  }

  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);

  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost // substitution
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }

  return prev[b.length];
}

/**
 * Case-insensitive distance using lowercase normalization.
 * Reasonable for short identifiers/captions.
 */
export function fuzzyDistance(a: string, b: string): number {
  return levenshtein(a.toLowerCase(), b.toLowerCase());
}

export interface SuggestOptions {
  /** Максимум подсказок в выдаче (default 5) */
  maxResults?: number;
  /** Максимально допустимая нормированная дистанция (default 0.5: половина длины) */
  maxNormalizedDistance?: number;
}

/**
 * Find best matches for `query` among `candidates` using fuzzy distance.
 * Returns candidates sorted by distance ascending; filters out matches
 * with normalized distance > maxNormalizedDistance.
 */
export function suggest(query: string, candidates: string[], options: SuggestOptions = {}): string[] {
  const max = options.maxResults ?? 5;
  const threshold = options.maxNormalizedDistance ?? 0.5;
  if (!query || candidates.length === 0) return [];

  const seen = new Set<string>();
  const scored: Array<{ candidate: string; score: number }> = [];

  for (const c of candidates) {
    if (!c || seen.has(c)) continue;
    seen.add(c);
    const distance = fuzzyDistance(query, c);
    const normalized = distance / Math.max(query.length, c.length);
    if (normalized <= threshold) {
      scored.push({ candidate: c, score: normalized });
    }
  }

  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, max).map((s) => s.candidate);
}

/**
 * Suggest from a name+caption pair list. Returns deduplicated `name [caption]`
 * strings sorted by best match across either field.
 */
export function suggestFields(
  query: string,
  fields: Array<{ name: string; caption?: string }>,
  options: SuggestOptions = {}
): string[] {
  const max = options.maxResults ?? 5;
  const threshold = options.maxNormalizedDistance ?? 0.5;
  if (!query || fields.length === 0) return [];

  const scored: Array<{ display: string; score: number }> = [];
  for (const field of fields) {
    let best = Infinity;
    const candidates: string[] = [field.name];
    if (field.caption) candidates.push(field.caption);
    for (const cand of candidates) {
      const dist = fuzzyDistance(query, cand);
      const norm = dist / Math.max(query.length, cand.length);
      if (norm < best) best = norm;
    }
    if (best <= threshold) {
      const display = field.caption ? `${field.name} [${field.caption}]` : field.name;
      scored.push({ display, score: best });
    }
  }

  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, max).map((s) => s.display);
}

/**
 * Damerau-Levenshtein в варианте OSA: перестановка соседних букв («Nmae» → «Name») стоит 1,
 * а не 2, как в обычном Levenshtein. Без учёта регистра.
 */
export function damerauLevenshtein(a: string, b: string): number {
  a = a.toLowerCase();
  b = b.toLowerCase();
  if (a === b) return 0;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/**
 * Единственный однозначный кандидат для автоисправления опечатки, иначе null.
 * Каждый кандидат сравнивается по нескольким ключам (имя, имя без Id, подпись) — берётся лучший.
 * Условия: запрос не короче 3 символов, дистанция ≤ 1 для коротких (≤ 5) и ≤ 2 для длинных,
 * и лучший кандидат строго ближе второго — иначе угадывать нельзя.
 */
export function uniqueClosest<T>(
  query: string,
  candidates: Array<{ value: T; keys: Array<string | undefined> }>
): T | null {
  if (query.length < 3) return null;
  const limit = query.length <= 5 ? 1 : 2;
  let best: { value: T; distance: number } | null = null;
  let second = Infinity;
  for (const c of candidates) {
    const distance = Math.min(
      ...c.keys.filter((k): k is string => Boolean(k)).map((k) => damerauLevenshtein(query, k))
    );
    if (!best || distance < best.distance) {
      if (best) second = best.distance;
      best = { value: c.value, distance };
    } else if (distance < second) {
      second = distance;
    }
  }
  return best && best.distance <= limit && second > best.distance ? best.value : null;
}
