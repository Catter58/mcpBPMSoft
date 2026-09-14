/**
 * Типы движка поиска дублей. Движок чистый: никакой сети, только сравнение
 * уже загруженных записей.
 */

export type DedupKind = 'person' | 'organization' | 'generic';

export interface DedupRecord {
  id: string;
  kind: DedupKind;
  /** ФИО / название организации / отображаемое имя */
  name?: string;
  emails: string[];
  phones: string[];
  /** ИНН (10/12 цифр) — только организации / ИП */
  inn?: string;
  website?: string;
  /** контакт: его контрагент (усиливает совпадение) */
  accountId?: string;
  /** ISO; разные заполненные даты — конфликт */
  birthDate?: string;
  /** ISO */
  createdOn?: string;
  /** сколько содержательных полей заполнено (для выбора мастера) */
  filled?: number;
}

export type MatchKey = 'email' | 'phone' | 'inn' | 'website' | 'name_exact' | 'name_fuzzy' | 'account';

export interface MatchReason {
  key: MatchKey;
  value: string;
  weight: number;
}

export interface DuplicatePair {
  a: string;
  b: string;
  score: number;
  reasons: MatchReason[];
  conflicts: string[];
}

export type DuplicateLevel = 'exact' | 'likely' | 'possible';

export interface DuplicateCluster {
  ids: string[];
  /** минимальный score среди рёбер максимального остовного дерева («самое слабое звено цепочки») */
  score: number;
  level: DuplicateLevel;
  pairs: DuplicatePair[];
}

export interface DetectOptions {
  /** минимальный score пары; по умолчанию LEVEL_THRESHOLDS.possible */
  threshold?: number;
  /** блоки крупнее пропускаются (общий телефон офиса, частое ФИО); по умолчанию 200 */
  maxBlockSize?: number;
}
