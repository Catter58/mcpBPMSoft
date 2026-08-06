import { describe, it, expect } from 'vitest';
import { normalizeName, scoreCandidate, pickConfidentIndex } from '../../src/utils/name-normalize.js';

describe('normalizeName', () => {
  it.each([
    ['АО «ЛАНИТ»', 'ао ланит', 'ланит'],
    ['АО ЛАНИТ', 'ао ланит', 'ланит'],
    ['Ланит', 'ланит', 'ланит'],
    ['АО "ЛАНИТ"', 'ао ланит', 'ланит'],
    ['ООО „Ромашка“', 'ооо ромашка', 'ромашка'],
    ['ПАО Сбербанк', 'пао сбербанк', 'сбербанк'],
    ['Ёлка ООО', 'елка ооо', 'елка'],
    ['ACME LLC', 'acme llc', 'acme'],
  ])('%s → normalized=%s core=%s', (raw, normalized, core) => {
    const n = normalizeName(raw);
    expect(n.normalized).toBe(normalized);
    expect(n.core).toBe(core);
  });

  it('орг-форма без ядра сохраняет normalized как core', () => {
    expect(normalizeName('ООО').core).toBe('ооо');
  });

  it('схлопывает пробелы и убирает только кавычки', () => {
    expect(normalizeName('  АО   «ЛАН ИТ»  ').normalized).toBe('ао лан ит');
  });

  it('пустая строка не ломается', () => {
    const n = normalizeName('');
    expect(n.normalized).toBe('');
    expect(n.core).toBe('');
    expect(n.tokens).toEqual([]);
  });
});

describe('scoreCandidate', () => {
  const q = normalizeName('Ланит');
  it('точное normalized = 100', () => {
    expect(scoreCandidate(normalizeName('ланит'), normalizeName('Ланит'))).toBe(100);
  });
  it('точное core = 90', () => {
    expect(scoreCandidate(q, normalizeName('АО «ЛАНИТ»'))).toBe(90);
  });
  it('core-префикс = 70', () => {
    expect(scoreCandidate(q, normalizeName('Ланит-Интеграция'))).toBe(70);
  });
  it('все токены запроса в кандидате = 55', () => {
    expect(scoreCandidate(normalizeName('ланит москва'), normalizeName('москва ланит центр'))).toBe(55);
  });
  it('подстрока core = 40', () => {
    expect(scoreCandidate(q, normalizeName('Урал-ланит-сервис'))).toBe(40);
  });
  it('нет пересечения = 0', () => {
    expect(scoreCandidate(q, normalizeName('Газпром'))).toBe(0);
  });
});

describe('pickConfidentIndex', () => {
  it('единственный лидер с отрывом ≥ 15', () => {
    expect(pickConfidentIndex([90, 40, 0])).toBe(0);
  });
  it('два близких — неоднозначно', () => {
    expect(pickConfidentIndex([90, 90])).toBeNull();
    expect(pickConfidentIndex([55, 45])).toBeNull();
  });
  it('score ниже 40 — нет лидера', () => {
    expect(pickConfidentIndex([30])).toBeNull();
    expect(pickConfidentIndex([])).toBeNull();
  });
  it('один кандидат ≥ 40 — лидер', () => {
    expect(pickConfidentIndex([40])).toBe(0);
  });
  it('лидер не на нулевой позиции', () => {
    expect(pickConfidentIndex([0, 40, 90])).toBe(2);
  });
});
