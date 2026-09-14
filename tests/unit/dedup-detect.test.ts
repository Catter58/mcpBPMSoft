import { describe, it, expect } from 'vitest';
import {
  LEVEL_THRESHOLDS,
  clusterPairs,
  findDuplicatePairs,
  matchAgainst,
  scorePair,
  suggestMaster,
  typoKeys,
} from '../../src/dedup/detect.js';
import type { DedupRecord, DuplicateCluster, DuplicatePair } from '../../src/dedup/types.js';

function person(id: string, fields: Partial<DedupRecord> = {}): DedupRecord {
  return { id, kind: 'person', emails: [], phones: [], ...fields };
}

function org(id: string, fields: Partial<DedupRecord> = {}): DedupRecord {
  return { id, kind: 'organization', emails: [], phones: [], ...fields };
}

function pair(a: string, b: string, score: number): DuplicatePair {
  return { a, b, score, reasons: [], conflicts: [] };
}

describe('scorePair: персоны', () => {
  it('ФИО в другом порядке, ё/е и один телефон в разных форматах → likely', () => {
    const p = scorePair(
      person('1', { name: 'Сёмин Пётр Ильич', phones: ['+7 (916) 123-45-67'] }),
      person('2', { name: 'Петр Ильич Семин', phones: ['89161234567'] })
    );
    expect(p.reasons.map((r) => r.key).sort()).toEqual(['name_exact', 'phone']);
    expect(p.score).toBeGreaterThanOrEqual(LEVEL_THRESHOLDS.likely);
  });

  it('инициалы + телефон без кода страны → likely', () => {
    const p = scorePair(
      person('1', { name: 'Иванов И. И.', phones: ['9161234567'] }),
      person('2', { name: 'Иванов Иван Иванович', phones: ['+79161234567'] })
    );
    expect(p.reasons.some((r) => r.key === 'name_fuzzy')).toBe(true);
    expect(p.score).toBeGreaterThanOrEqual(LEVEL_THRESHOLDS.likely);
  });

  it('gmail с точками + одинаковое ФИО → exact', () => {
    const p = scorePair(
      person('1', { name: 'Иванов Иван', emails: ['ivan.ivanov@gmail.com'] }),
      person('2', { name: 'Иванов Иван', emails: ['ivanivanov+crm@googlemail.com'] })
    );
    expect(p.score).toBeGreaterThanOrEqual(LEVEL_THRESHOLDS.exact);
  });

  it('общий телефон офиса у разных людей с разными e-mail — ниже likely и даже possible', () => {
    const p = scorePair(
      person('1', { name: 'Иванов Иван', emails: ['ivanov@romashka.ru'], phones: ['+7 495 100-00-00'] }),
      person('2', { name: 'Петрова Анна', emails: ['petrova@romashka.ru'], phones: ['84951000000'] })
    );
    expect(p.score).toBeLessThan(LEVEL_THRESHOLDS.likely);
    expect(p.score).toBeLessThan(LEVEL_THRESHOLDS.possible);
    expect(p.conflicts.length).toBeGreaterThanOrEqual(2);
  });

  it('разные даты рождения — конфликт', () => {
    const p = scorePair(
      person('1', { name: 'Иванов Иван', phones: ['9161234567'], birthDate: '1980-01-01' }),
      person('2', { name: 'Иванов Иван', phones: ['9161234567'], birthDate: '1990-05-05T00:00:00Z' })
    );
    expect(p.conflicts).toHaveLength(1);
    expect(p.score).toBeLessThan(LEVEL_THRESHOLDS.possible);
  });

  it('общий контрагент усиливает только при сигнале по имени', () => {
    const withName = scorePair(
      person('1', { name: 'Иванов Иван', accountId: 'acc' }),
      person('2', { name: 'Иванов Иван', accountId: 'acc' })
    );
    expect(withName.reasons.map((r) => r.key)).toContain('account');
    expect(withName.score).toBeGreaterThan(0.6);
    const noName = scorePair(person('1', { accountId: 'acc' }), person('2', { accountId: 'acc' }));
    expect(noName.score).toBe(0);
  });

  it('только нечёткое имя для generic не дотягивает до likely', () => {
    const p = scorePair(
      { id: '1', kind: 'generic', name: 'Проект Ромашка', emails: [], phones: [] },
      { id: '2', kind: 'generic', name: 'Проект Ромашки', emails: [], phones: [] }
    );
    expect(p.score).toBeGreaterThan(0);
    expect(p.score).toBeLessThan(LEVEL_THRESHOLDS.likely);
  });
});

describe('scorePair: организации', () => {
  it("'ООО «Ромашка»' ~ 'Ромашка ООО' ~ 'Romashka LLC' — точное имя", () => {
    const a = org('1', { name: 'ООО «Ромашка»' });
    for (const other of ['Ромашка ООО', 'Romashka LLC']) {
      const p = scorePair(a, org('2', { name: other }));
      expect(p.reasons.map((r) => r.key)).toEqual(['name_exact']);
      expect(p.score).toBe(0.7);
    }
  });

  it('одинаковый ИНН → exact', () => {
    const p = scorePair(org('1', { inn: '7707083893' }), org('2', { inn: '7707 083 893' }));
    expect(p.score).toBeGreaterThanOrEqual(LEVEL_THRESHOLDS.exact);
  });

  it('разные ИНН блокируют слияние при одинаковых названии, телефоне и сайте', () => {
    const p = scorePair(
      org('1', { name: 'ООО Ромашка', inn: '7707083893', phones: ['84951234567'], website: 'romashka.ru' }),
      org('2', { name: 'Ромашка', inn: '5001012345', phones: ['+74951234567'], website: 'www.romashka.ru' })
    );
    expect(p.conflicts[0]).toContain('ИНН');
    expect(p.score).toBeLessThan(LEVEL_THRESHOLDS.possible);
  });

  it('сайт на бесплатном почтовом домене не считается', () => {
    const p = scorePair(org('1', { website: 'mail.ru' }), org('2', { website: 'https://mail.ru/' }));
    expect(p.score).toBe(0);
  });
});

describe('findDuplicatePairs', () => {
  it('находит пары через блоки и не сравнивает разные виды', () => {
    const records = [
      org('o1', { name: 'ООО «Ромашка»', website: 'romashka.ru' }),
      org('o2', { name: 'Romashka LLC', website: 'https://www.romashka.ru/contacts' }),
      person('p1', { name: 'Ромашка', emails: ['info@romashka.ru'] }),
      person('p2', { name: 'Иванов Иван Иванович', emails: ['ivanov@romashka.ru'] }),
      person('p3', { name: 'Иванов И. И.', phones: ['89161234567'], emails: ['IVANOV@romashka.ru'] }),
      person('p4', { name: 'Сидоров Сидор' }),
    ];
    const pairs = findDuplicatePairs(records);
    const ids = pairs.map((p) => [p.a, p.b].join('-'));
    expect(ids).toEqual(expect.arrayContaining(['o1-o2', 'p2-p3']));
    expect(ids.some((id) => id.includes('p1') || id.includes('p4'))).toBe(false);
    for (let i = 1; i < pairs.length; i++) expect(pairs[i - 1].score).toBeGreaterThanOrEqual(pairs[i].score);
  });

  it('нечёткий блок по ФИО находит дубль без общих контактов', () => {
    const pairs = findDuplicatePairs(
      [
        person('1', { name: 'Иванов Иван Иванович', accountId: 'acc' }),
        person('2', { name: 'Иванов И. И.', accountId: 'acc' }),
      ],
      { threshold: 0.4 }
    );
    expect(pairs).toHaveLength(1);
    expect(pairs[0].reasons.map((r) => r.key)).toEqual(['name_fuzzy', 'account']);
  });

  it('блок крупнее maxBlockSize пропускается без ошибки', () => {
    const records = Array.from({ length: 30 }, (_, i) =>
      person(`p${i}`, { name: `Сотрудник${i}`, phones: ['+7 495 000-00-00'] })
    );
    records.push(person('x', { name: 'Иванов Иван', emails: ['ivanov@x.ru'], phones: ['+7 495 000-00-00'] }));
    records.push(person('y', { name: 'Иванов Иван', emails: ['ivanov@x.ru'] }));
    const pairs = findDuplicatePairs(records, { maxBlockSize: 10, threshold: 0 });
    expect(pairs.map((p) => `${p.a}-${p.b}`)).toEqual(['x-y']);
  });

  it('производительность: 20 000 записей быстрее 3 с', () => {
    const surnames = ['Иванов', 'Петров', 'Сидоров', 'Смирнов', 'Кузнецов', 'Попов', 'Васильев', 'Соколов'];
    const names = ['Иван', 'Пётр', 'Анна', 'Мария', 'Олег', 'Елена', 'Сергей', 'Ольга', 'Дмитрий', 'Юлия'];
    const records: DedupRecord[] = [];
    for (let i = 0; i < 20_000; i++) {
      const surname = `${surnames[i % surnames.length]}${String.fromCharCode(1072 + ((i >> 3) % 32))}${i % 97}`;
      const name = names[(i * 7) % names.length];
      records.push(
        person(`p${i}`, {
          name: `${surname} ${name}`,
          emails: [`user${i}@corp${i % 50}.ru`],
          phones: [i % 10 === 0 ? '+7 495 111-11-11' : `+7 9${String(i).padStart(9, '0')}`],
        })
      );
      if (i % 20 === 0) {
        records.push(person(`d${i}`, { name: `${name} ${surname}`, emails: [`USER${i}@corp${i % 50}.ru`] }));
      }
    }
    const started = performance.now();
    const pairs = findDuplicatePairs(records);
    const elapsed = performance.now() - started;
    const clusters = clusterPairs(pairs);
    expect(clusters.length).toBeGreaterThanOrEqual(1000);
    expect(elapsed).toBeLessThan(3000);
  });
});

describe('clusterPairs', () => {
  it('цепочка A~B, B~C → один кластер, score = слабое звено', () => {
    const clusters = clusterPairs([pair('A', 'B', 0.97), pair('B', 'C', 0.85), pair('D', 'E', 0.62)]);
    expect(clusters).toHaveLength(2);
    expect(clusters[0].ids.sort()).toEqual(['A', 'B', 'C']);
    expect(clusters[0].score).toBe(0.85);
    expect(clusters[0].level).toBe('likely');
    expect(clusters[0].pairs).toHaveLength(2);
    expect(clusters[1].level).toBe('possible');
  });

  it('score остова игнорирует слабое ребро, если есть более сильный путь', () => {
    const [cluster] = clusterPairs([pair('A', 'B', 0.99), pair('B', 'C', 0.96), pair('A', 'C', 0.7)]);
    expect(cluster.score).toBe(0.96);
    expect(cluster.level).toBe('exact');
    expect(cluster.pairs).toHaveLength(3);
  });

  it('пары ниже порога не объединяют', () => {
    expect(clusterPairs([pair('A', 'B', 0.5)])).toEqual([]);
  });

  it('равный score — больший кластер выше', () => {
    const clusters = clusterPairs([pair('X', 'Y', 0.9), pair('A', 'B', 0.9), pair('B', 'C', 0.9)]);
    expect(clusters[0].ids).toHaveLength(3);
  });

  it('цепочка из реальных записей: e-mail связывает A-B, телефон и имя — B-C', () => {
    const records = [
      person('A', { name: 'Иванов Иван', emails: ['ivanov@corp.ru'] }),
      person('B', { name: 'Иванов Иван Иванович', emails: ['ivanov@corp.ru'], phones: ['89161234567'] }),
      person('C', { name: 'Иванов Иван Иванович', phones: ['+7 916 123 45 67'] }),
    ];
    const clusters = clusterPairs(findDuplicatePairs(records), LEVEL_THRESHOLDS.likely);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].ids.sort()).toEqual(['A', 'B', 'C']);
  });
});

describe('matchAgainst', () => {
  it('кандидат ещё не создан (id пустой)', () => {
    const existing = [
      org('o1', { name: 'ООО «Ромашка»', inn: '7707083893' }),
      org('o2', { name: 'Василёк', phones: ['84951234567'] }),
      org('o3', { name: 'Ромашка-Сервис' }),
    ];
    const result = matchAgainst(org('', { name: 'Romashka LLC', inn: '7707083893' }), existing);
    expect(result[0]).toMatchObject({ a: '', b: 'o1' });
    expect(result[0].score).toBeGreaterThanOrEqual(LEVEL_THRESHOLDS.exact);
    expect(result.map((p) => p.b)).not.toContain('o2');
  });

  it('пропускает саму себя', () => {
    const rec = person('p1', { name: 'Иванов Иван', emails: ['i@x.ru'] });
    expect(matchAgainst(rec, [rec])).toEqual([]);
  });
});

describe('suggestMaster', () => {
  const cluster: DuplicateCluster = { ids: ['a', 'b', 'c'], score: 0.9, level: 'likely', pairs: [] };
  const records = new Map<string, DedupRecord>([
    ['a', person('a', { filled: 3, createdOn: '2024-01-01T00:00:00Z' })],
    ['b', person('b', { filled: 5, createdOn: '2025-01-01T00:00:00Z' })],
    ['c', person('c', { filled: 5, createdOn: '2023-01-01T00:00:00Z' })],
  ]);

  it('больше связей важнее заполненности', () => {
    expect(
      suggestMaster(
        cluster,
        records,
        new Map([
          ['a', 10],
          ['b', 2],
        ])
      )
    ).toBe('a');
  });

  it('при равных связях — больше заполненных полей, затем самая старая', () => {
    expect(suggestMaster(cluster, records)).toBe('c');
    expect(
      suggestMaster(
        cluster,
        records,
        new Map([
          ['b', 1],
          ['c', 1],
        ])
      )
    ).toBe('c');
  });

  it('без filled считает поля сам', () => {
    const m = new Map<string, DedupRecord>([
      ['a', person('a', { name: 'Иванов' })],
      ['b', person('b', { name: 'Иванов', emails: ['i@x.ru'], phones: ['9161234567'] })],
      ['c', person('c')],
    ]);
    expect(suggestMaster(cluster, m)).toBe('b');
  });
});

describe('опечатка в начале слова', () => {
  const shareKey = (a: string, b: string) => typoKeys(a).some((k) => typoKeys(b).includes(k));
  const found = (records: DedupRecord[]) =>
    findDuplicatePairs(records, { threshold: 0 }).some((p) => [p.a, p.b].sort().join() === '1,2');

  it('typoKeys: замена, перестановка и пропуск буквы в первых пяти оставляют общий ключ', () => {
    expect(shareKey('ivanov', 'yvanov')).toBe(true); // замена первой буквы
    expect(shareKey('petrov', 'pertov')).toBe(true); // перестановка соседних
    expect(shareKey('romashka', 'rmashka')).toBe(true); // пропуск
    expect(shareKey('sidorov', 'petrov')).toBe(false);
  });

  it('персоны с опечаткой в первой букве фамилии или перестановкой попадают в один блок', () => {
    expect(found([person('1', { name: 'Иванов Иван' }), person('2', { name: 'Ыванов Иван' })])).toBe(true);
    expect(found([person('1', { name: 'Петров Пётр' }), person('2', { name: 'Пертов Петр' })])).toBe(true);
    expect(found([person('1', { name: 'Иванов' }), person('2', { name: 'Иваонв' })])).toBe(true);
  });

  it('организации с перестановкой букв в начале названия попадают в один блок', () => {
    expect(found([org('1', { name: 'ООО «Ромашка»' }), org('2', { name: 'Рмоашка ООО' })])).toBe(true);
  });

  it('опечатка + общий телефон — вероятный дубль, а не просто кандидат', () => {
    const p = scorePair(
      person('1', { name: 'Иванов Иван Петрович', phones: ['+7 916 123-45-67'] }),
      person('2', { name: 'Иванов Иван Птерович', phones: ['89161234567'] })
    );
    expect(p.reasons.map((r) => r.key)).toContain('name_fuzzy');
    expect(p.score).toBeGreaterThanOrEqual(LEVEL_THRESHOLDS.likely);
  });

  it('одна опечатка в полном ФИО без других совпадений — хотя бы possible, но не likely', () => {
    const p = scorePair(
      person('1', { name: 'Уванов Иван Петрович' }),
      person('2', { name: 'Иванов Иван Петрович' })
    );
    expect(p.reasons.map((r) => r.key)).toContain('name_fuzzy');
    expect(p.score).toBeGreaterThanOrEqual(LEVEL_THRESHOLDS.possible);
    expect(p.score).toBeLessThan(LEVEL_THRESHOLDS.likely);
  });

  it('разные люди с похожей фамилией не поднимаются до possible', () => {
    const p = scorePair(person('1', { name: 'Иванов Иван' }), person('2', { name: 'Иваненко Пётр' }));
    expect(p.score).toBeLessThan(LEVEL_THRESHOLDS.possible);
  });
});
