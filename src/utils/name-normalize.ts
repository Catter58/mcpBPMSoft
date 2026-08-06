/**
 * Name normalization & ranking for fuzzy lookup of business names.
 *
 * «АО «ЛАНИТ»», «АО ЛАНИТ», «Ланит», «АО "ЛАНИТ"» must converge to the same
 * core «ланит» so the lookup cascade can match them server-side (contains)
 * and rank candidates client-side.
 */

export interface NormalizedName {
  /** lowercase, ё→е, без кавычек, пробелы схлопнуты */
  normalized: string;
  /** normalized минус орг-формы (АО/ООО/...) по краям; пустое ядро → normalized */
  core: string;
  /** токены core (или normalized целиком, если ядро оказалось пустым) */
  tokens: string[];
}

const QUOTE_RE = /[«»„“”‟"'’‘`]/g;

const LEGAL_FORMS = new Set([
  'ао', 'оао', 'зао', 'пао', 'ооо', 'ип', 'ано', 'нко', 'гуп', 'муп', 'фгуп', 'фгбу',
  'тоо', 'нпо', 'нпп', 'пк', 'спк', 'чоп', 'тсж',
  'llc', 'ltd', 'inc', 'gmbh', 'jsc', 'pjsc', 'ojsc', 'co', 'corp',
]);

export function normalizeName(raw: string): NormalizedName {
  const normalized = raw
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(QUOTE_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const allTokens = normalized.split(' ').filter(Boolean);
  let start = 0;
  let end = allTokens.length;
  while (start < end && LEGAL_FORMS.has(allTokens[start])) start++;
  while (end > start && LEGAL_FORMS.has(allTokens[end - 1])) end--;

  const coreTokens = allTokens.slice(start, end);
  const core = coreTokens.length > 0 ? coreTokens.join(' ') : normalized;
  return { normalized, core, tokens: coreTokens.length > 0 ? coreTokens : allTokens };
}

/** 100 exact normalized > 90 exact core > 70 core-prefix > 55 token subset > 40 substring > 0 */
export function scoreCandidate(query: NormalizedName, candidate: NormalizedName): number {
  if (candidate.normalized === query.normalized) return 100;
  if (candidate.core === query.core) return 90;
  if (candidate.core.startsWith(query.core)) return 70;
  const candTokens = new Set(candidate.tokens);
  if (query.tokens.length > 0 && query.tokens.every((t) => candTokens.has(t))) return 55;
  if (candidate.core.includes(query.core)) return 40;
  return 0;
}

/**
 * Index of the confident leader: max score ≥ 40 AND either no rivals or the
 * runner-up trails by ≥ 15 points. A tie or weak signal → null (ambiguous).
 */
export function pickConfidentIndex(scores: number[]): number | null {
  if (scores.length === 0) return null;
  let best = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
  if (scores[best] < 40) return null;
  let second = -1;
  for (let i = 0; i < scores.length; i++) {
    if (i !== best && scores[i] > second) second = scores[i];
  }
  if (second >= 0 && scores[best] - second < 15) return null;
  return best;
}
