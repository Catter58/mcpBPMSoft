/**
 * Поиск дублей: оценка пары, блокинг ~O(n), кластеризация, выбор мастер-записи.
 *
 * Оценка — noisy-OR: score = (1 − Π(1 − w_i)) × Π(множители конфликтов).
 * Веса сигналов (WEIGHTS):
 *   email 0.9, phone 0.7, inn 0.98, website 0.6,
 *   name_exact 0.6 (персона/generic) / 0.7 (организация),
 *   name_fuzzy = похожесть × 0.5 (только при похожести ≥ 0.85),
 *   account 0.2 (персоны, общий контрагент, только вместе с сигналом по имени).
 * По каждому виду сигнала учитывается одно совпадение (второй общий телефон score не поднимает).
 * Конфликты (CONFLICTS):
 *   разные ИНН ×0.2; разные даты рождения ×0.4;
 *   персоны: у обоих есть e-mail, общих нет и имя не совпало точно ×0.7;
 *   персоны: оба ФИО заполнены и похожесть < 0.5 ×0.5 (общий телефон/ящик офиса у разных людей).
 * Сравнение имён — по латинскому ключу, поэтому 'Ромашка' и 'Romashka' совпадают точно.
 */

import {
  latinKey,
  normalizeByKind,
  normalizeDomain,
  normalizeEmail,
  normalizeInn,
  normalizePhone,
  personSimilarity,
  personTokens,
  textSimilarity,
  textTokens,
  type NameToken,
} from './normalize.js';
import type {
  DedupKind,
  DedupRecord,
  DetectOptions,
  DuplicateCluster,
  DuplicateLevel,
  DuplicatePair,
  MatchReason,
} from './types.js';

export const LEVEL_THRESHOLDS = { exact: 0.95, likely: 0.8, possible: 0.6 };

const WEIGHTS = {
  email: 0.9,
  phone: 0.7,
  inn: 0.98,
  website: 0.6,
  nameExactPerson: 0.6,
  nameExactOrg: 0.7,
  nameFuzzyFactor: 0.5,
  nameFuzzyMin: 0.85,
  /** Почти точное совпадение (одна опечатка в полном ФИО/названии): вес поднимается до «possible», но не выше точного. */
  nameFuzzyStrongMin: 0.92,
  nameFuzzyStrongFactor: 0.65,
  account: 0.2,
};

const CONFLICTS = {
  inn: 0.2,
  birthDate: 0.4,
  personEmails: 0.7,
  personNames: 0.5,
};

/** Похожесть ФИО ниже этого порога — конфликт «разные ФИО». */
const PERSON_NAME_CONFLICT_BELOW = 0.5;

const DEFAULT_MAX_BLOCK = 200;

interface Prepared {
  rec: DedupRecord;
  emails: string[];
  phones: string[];
  inn: string | null;
  domain: string | null;
  /** нормализованное имя (для текста причины) */
  name: string;
  /** латинский ключ имени, токены отсортированы; '' — имени нет */
  nameKey: string;
  personTokens: NameToken[];
  textTokens: string[];
  birthDate: string;
}

function fuzzyNameWeight(similarity: number, kind: DedupKind): number {
  if (similarity < WEIGHTS.nameFuzzyStrongMin) return similarity * WEIGHTS.nameFuzzyFactor;
  const exact = kind === 'organization' ? WEIGHTS.nameExactOrg : WEIGHTS.nameExactPerson;
  return Math.min(similarity * WEIGHTS.nameFuzzyStrongFactor, exact);
}

function uniq(values: (string | null)[]): string[] {
  return [...new Set(values.filter((v): v is string => !!v))];
}

function prepare(rec: DedupRecord): Prepared {
  const name = rec.name ? normalizeByKind(rec.name, rec.kind) : '';
  const tokens = name ? name.split(' ').map(latinKey).sort() : [];
  return {
    rec,
    emails: uniq(rec.emails.map(normalizeEmail)),
    phones: uniq(rec.phones.map(normalizePhone)),
    inn: rec.inn ? normalizeInn(rec.inn) : null,
    domain: rec.website ? normalizeDomain(rec.website) : null,
    name,
    nameKey: tokens.join(' '),
    personTokens: rec.kind === 'person' && rec.name ? personTokens(rec.name) : [],
    textTokens: rec.kind !== 'person' && rec.name ? textTokens(rec.name, rec.kind) : [],
    birthDate: rec.birthDate ? rec.birthDate.slice(0, 10) : '',
  };
}

function firstShared(a: string[], b: string[]): string | undefined {
  return a.find((v) => b.includes(v));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function scorePrepared(pa: Prepared, pb: Prepared): DuplicatePair {
  const kind: DedupKind = pa.rec.kind === pb.rec.kind ? pa.rec.kind : 'generic';
  const reasons: MatchReason[] = [];
  const conflicts: string[] = [];
  let factor = 1;

  const email = firstShared(pa.emails, pb.emails);
  if (email) reasons.push({ key: 'email', value: email, weight: WEIGHTS.email });
  const phone = firstShared(pa.phones, pb.phones);
  if (phone) reasons.push({ key: 'phone', value: phone, weight: WEIGHTS.phone });
  if (pa.inn && pa.inn === pb.inn) reasons.push({ key: 'inn', value: pa.inn, weight: WEIGHTS.inn });
  if (pa.domain && pa.domain === pb.domain) {
    reasons.push({ key: 'website', value: pa.domain, weight: WEIGHTS.website });
  }

  let nameExact = false;
  let nameSignal = false;
  if (pa.nameKey && pb.nameKey) {
    if (pa.nameKey === pb.nameKey) {
      nameExact = nameSignal = true;
      const weight = kind === 'organization' ? WEIGHTS.nameExactOrg : WEIGHTS.nameExactPerson;
      reasons.push({ key: 'name_exact', value: pa.name, weight });
    } else {
      const similarity =
        kind === 'person'
          ? personSimilarity(pa.personTokens, pb.personTokens)
          : textSimilarity(
              pa.textTokens.length ? pa.textTokens : pa.nameKey.split(' '),
              pb.textTokens.length ? pb.textTokens : pb.nameKey.split(' ')
            );
      if (similarity >= WEIGHTS.nameFuzzyMin) {
        nameSignal = true;
        reasons.push({
          key: 'name_fuzzy',
          value: `${pa.name} ~ ${pb.name}`,
          weight: round(fuzzyNameWeight(similarity, kind)),
        });
      } else if (kind === 'person' && similarity < PERSON_NAME_CONFLICT_BELOW) {
        factor *= CONFLICTS.personNames;
        conflicts.push(`разные ФИО: «${pa.rec.name}» / «${pb.rec.name}»`);
      }
    }
  }

  if (kind === 'person' && nameSignal && pa.rec.accountId && pa.rec.accountId === pb.rec.accountId) {
    reasons.push({ key: 'account', value: pa.rec.accountId, weight: WEIGHTS.account });
  }

  if (pa.inn && pb.inn && pa.inn !== pb.inn) {
    factor *= CONFLICTS.inn;
    conflicts.push(`разные ИНН: ${pa.inn} / ${pb.inn}`);
  }
  if (pa.birthDate && pb.birthDate && pa.birthDate !== pb.birthDate) {
    factor *= CONFLICTS.birthDate;
    conflicts.push(`разные даты рождения: ${pa.birthDate} / ${pb.birthDate}`);
  }
  if (kind === 'person' && !nameExact && pa.emails.length && pb.emails.length && !email) {
    factor *= CONFLICTS.personEmails;
    conflicts.push('разные e-mail без общих');
  }

  const base = 1 - reasons.reduce((acc, r) => acc * (1 - r.weight), 1);
  return { a: pa.rec.id, b: pb.rec.id, score: round(base * factor), reasons, conflicts };
}

export function scorePair(a: DedupRecord, b: DedupRecord): DuplicatePair {
  return scorePrepared(prepare(a), prepare(b));
}

/**
 * Ключи блоков. Точные: email/phone/inn/domain/name. Нечёткие:
 * персона — для каждого полного токена «первые 4 буквы латиницей | первая буква другого токена»
 * ('Иванов И. И.' и 'Иванов Иван Иванович' оба дают 'ivan|i');
 * организация/generic — первые 5 букв латинского ключа подряд и по отсортированным токенам.
 */
function blockKeys(p: Prepared): string[] {
  const kind = p.rec.kind;
  const keys = [...p.emails.map((v) => `email:${v}`), ...p.phones.map((v) => `phone:${v}`)];
  if (p.inn) keys.push(`inn:${p.inn}`);
  if (p.domain) keys.push(`domain:${p.domain}`);
  if (p.nameKey) keys.push(`name:${kind}:${p.nameKey}`);
  if (kind === 'person') {
    const tokens = p.personTokens;
    const words = tokens.filter((t) => !t.initial && t.key.length >= 3);
    for (const t of words) {
      const fragments = typoKeys(t.key);
      const others = tokens.filter((u) => u !== t);
      // Однословное имя: сравнивать больше не с чем — блок только по самому слову.
      if (others.length === 0) fragments.forEach((f) => keys.push(`fz:person:${f}`));
      for (const u of others) fragments.forEach((f) => keys.push(`fz:person:${f}|${u.key[0]}`));
    }
  } else if (p.textTokens.length) {
    const direct = p.textTokens.join('');
    const sorted = [...p.textTokens].sort().join('');
    for (const text of new Set([direct, sorted])) {
      if (text.length >= 3) typoKeys(text).forEach((f) => keys.push(`fz:${kind}:${f}`));
    }
  }
  return keys;
}

/**
 * Ключи блоков, устойчивые к одной опечатке в начале слова: окно из первых 5 букв, все его
 * варианты без одной буквы (замена, пропуск и перестановка соседних букв оставляют общий вариант)
 * и последние 4 буквы — на случай, когда опечаток в начале несколько.
 * ponytail: две опечатки в первых 5 буквах короткого слова всё ещё разводят записи по разным блокам.
 */
export function typoKeys(word: string): string[] {
  const window = word.slice(0, 5);
  const keys = new Set([`p:${window}`]);
  if (window.length >= 4) {
    for (let i = 0; i < window.length; i++) keys.add(`d:${window.slice(0, i)}${window.slice(i + 1)}`);
  }
  if (word.length >= 6) keys.add(`s:${word.slice(-4)}`);
  return [...keys];
}

function byScoreDesc(x: DuplicatePair, y: DuplicatePair): number {
  return y.score - x.score;
}

/**
 * Все пары-кандидаты с score ≥ threshold. Сравниваются только записи одного вида внутри общего блока;
 * блоки крупнее maxBlockSize пропускаются без ошибки.
 */
export function findDuplicatePairs(records: DedupRecord[], options: DetectOptions = {}): DuplicatePair[] {
  const threshold = options.threshold ?? LEVEL_THRESHOLDS.possible;
  const maxBlockSize = options.maxBlockSize ?? DEFAULT_MAX_BLOCK;
  const prepared = records.map(prepare);

  const blocks = new Map<string, number[]>();
  prepared.forEach((p, idx) => {
    for (const key of new Set(blockKeys(p))) {
      const block = blocks.get(key);
      if (block) block.push(idx);
      else blocks.set(key, [idx]);
    }
  });

  const n = records.length;
  const seen = new Set<number>();
  const pairs: DuplicatePair[] = [];
  for (const block of blocks.values()) {
    if (block.length < 2 || block.length > maxBlockSize) continue;
    for (let i = 0; i < block.length; i++) {
      for (let j = i + 1; j < block.length; j++) {
        const x = block[i];
        const y = block[j];
        const pairKey = x * n + y;
        if (seen.has(pairKey)) continue;
        seen.add(pairKey);
        if (prepared[x].rec.kind !== prepared[y].rec.kind) continue;
        const pair = scorePrepared(prepared[x], prepared[y]);
        if (pair.score >= threshold) pairs.push(pair);
      }
    }
  }
  return pairs.sort(byScoreDesc);
}

/** Сравнение новой (возможно, ещё не созданной, id = '') записи с найденными кандидатами. */
export function matchAgainst(
  candidate: DedupRecord,
  existing: DedupRecord[],
  options: DetectOptions = {}
): DuplicatePair[] {
  const threshold = options.threshold ?? LEVEL_THRESHOLDS.possible;
  const pc = prepare(candidate);
  const pairs: DuplicatePair[] = [];
  for (const rec of existing) {
    if (candidate.id && rec.id === candidate.id) continue;
    const pair = scorePrepared(pc, prepare(rec));
    if (pair.score >= threshold) pairs.push(pair);
  }
  return pairs.sort(byScoreDesc);
}

function levelOf(score: number): DuplicateLevel {
  if (score >= LEVEL_THRESHOLDS.exact) return 'exact';
  if (score >= LEVEL_THRESHOLDS.likely) return 'likely';
  return 'possible';
}

/**
 * Union-find по парам с score ≥ threshold (алгоритм Краскала по убыванию score).
 * Score кластера — минимум по рёбрам максимального остовного дерева, т. е. самое слабое звено
 * лучшей цепочки, связывающей все записи кластера. Сортировка: score ↓, размер ↓.
 */
export function clusterPairs(
  pairs: DuplicatePair[],
  threshold: number = LEVEL_THRESHOLDS.possible
): DuplicateCluster[] {
  const strong = pairs.filter((p) => p.score >= threshold).sort(byScoreDesc);
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    let cur = id;
    while (cur !== root) {
      const next = parent.get(cur) as string;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };

  const minEdge = new Map<string, number>();
  for (const p of strong) {
    if (!parent.has(p.a)) parent.set(p.a, p.a);
    if (!parent.has(p.b)) parent.set(p.b, p.b);
    const ra = find(p.a);
    const rb = find(p.b);
    if (ra === rb) continue;
    const merged = Math.min(p.score, minEdge.get(ra) ?? 1, minEdge.get(rb) ?? 1);
    parent.set(rb, ra);
    minEdge.set(ra, merged);
    minEdge.delete(rb);
  }

  const groups = new Map<string, DuplicateCluster>();
  for (const id of parent.keys()) {
    const root = find(id);
    let cluster = groups.get(root);
    if (!cluster) {
      const score = minEdge.get(root) ?? 0;
      cluster = { ids: [], score, level: levelOf(score), pairs: [] };
      groups.set(root, cluster);
    }
    cluster.ids.push(id);
  }
  for (const p of strong) groups.get(find(p.a))?.pairs.push(p);

  return [...groups.values()].sort((x, y) => y.score - x.score || y.ids.length - x.ids.length);
}

function countFilled(rec: DedupRecord): number {
  return (
    rec.filled ??
    [rec.name, rec.inn, rec.website, rec.accountId, rec.birthDate].filter(Boolean).length +
      rec.emails.length +
      rec.phones.length
  );
}

/** Мастер: больше всего связанных записей → больше заполненных полей → самая старая (createdOn). */
export function suggestMaster(
  cluster: DuplicateCluster,
  records: Map<string, DedupRecord>,
  relatedCounts?: Map<string, number>
): string {
  const ranked = cluster.ids.map((id, order) => {
    const rec = records.get(id);
    const created = rec?.createdOn ? Date.parse(rec.createdOn) : NaN;
    return {
      id,
      order,
      related: relatedCounts?.get(id) ?? 0,
      filled: rec ? countFilled(rec) : 0,
      created: Number.isNaN(created) ? Number.POSITIVE_INFINITY : created,
    };
  });
  ranked.sort(
    (x, y) => y.related - x.related || y.filled - x.filled || x.created - y.created || x.order - y.order
  );
  return ranked[0]?.id ?? '';
}
