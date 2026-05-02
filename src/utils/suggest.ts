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
        prev[j] + 1,        // deletion
        curr[j - 1] + 1,    // insertion
        prev[j - 1] + cost  // substitution
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
export function suggest(
  query: string,
  candidates: string[],
  options: SuggestOptions = {}
): string[] {
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
