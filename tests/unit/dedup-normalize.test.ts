import { describe, it, expect } from 'vitest';
import {
  latinKey,
  nameSimilarity,
  normalizeDomain,
  normalizeEmail,
  normalizeInn,
  normalizeOrgName,
  normalizePersonName,
  normalizePhone,
  transliterate,
} from '../../src/dedup/normalize.js';

describe('normalizePersonName', () => {
  it.each([
    ['Иванов Иван Иванович', 'иван иванов иванович'],
    ['Иван Иванович ИВАНОВ', 'иван иванов иванович'],
    ['  Сёмин,  Пётр ', 'петр семин'],
    ['Иванов И.И.', 'и и иванов'],
    ['', ''],
  ])('%s → %s', (raw, expected) => {
    expect(normalizePersonName(raw)).toBe(expected);
  });
});

describe('normalizeOrgName', () => {
  it.each([
    ['ООО «Ромашка»', 'ромашка'],
    ['Ромашка ООО', 'ромашка'],
    ['Ромашка, ООО', 'ромашка'],
    ['АО "Ёлка-Плюс"', 'елка плюс'],
    ['Romashka LLC', 'romashka'],
    ['Acme Ltd.', 'acme'],
    ['ГК „Альфа“', 'альфа'],
    ['ООО', 'ооо'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizeOrgName(raw)).toBe(expected);
  });
});

describe('normalizeEmail', () => {
  it('приводит к нижнему регистру и обрезает пробелы', () => {
    expect(normalizeEmail('  Ivanov@Company.RU ')).toBe('ivanov@company.ru');
  });
  it('gmail: точки и +тег в локальной части не значимы', () => {
    expect(normalizeEmail('I.Van.Ov+crm@gmail.com')).toBe('ivanov@gmail.com');
    expect(normalizeEmail('ivanov@googlemail.com')).toBe('ivanov@gmail.com');
  });
  it('не-gmail сохраняет точки', () => {
    expect(normalizeEmail('i.ivanov@mail.ru')).toBe('i.ivanov@mail.ru');
  });
  it.each(['', 'ivanov', 'ivanov@', '@mail.ru', 'a b@mail.ru'])('невалидный %s → null', (raw) => {
    expect(normalizeEmail(raw)).toBeNull();
  });
});

describe('normalizePhone', () => {
  it.each([
    ['+7 (916) 123-45-67', '9161234567'],
    ['89161234567', '9161234567'],
    ['9161234567', '9161234567'],
    ['+49 30 1234 5678', '3012345678'],
    ['123-45-67', '1234567'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizePhone(raw)).toBe(expected);
  });
  it('меньше 7 цифр → null', () => {
    expect(normalizePhone('12-34')).toBeNull();
    expect(normalizePhone('доб. 123')).toBeNull();
  });
});

describe('normalizeInn', () => {
  it('10 и 12 цифр', () => {
    expect(normalizeInn('7707083893')).toBe('7707083893');
    expect(normalizeInn(' 5001-0123-4567 ')).toBe('500101234567');
  });
  it('другая длина или нули → null', () => {
    expect(normalizeInn('12345')).toBeNull();
    expect(normalizeInn('0000000000')).toBeNull();
  });
});

describe('normalizeDomain', () => {
  it.each([
    ['https://www.Romashka.ru/about?x=1', 'romashka.ru'],
    ['romashka.ru:8080', 'romashka.ru'],
    ['http://shop.romashka.ru', 'shop.romashka.ru'],
    ['www.ромашка.рф', 'ромашка.рф'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizeDomain(raw)).toBe(expected);
  });
  it.each(['mail.ru', 'https://gmail.com', 'localhost', ''])('%s → null', (raw) => {
    expect(normalizeDomain(raw)).toBeNull();
  });
});

describe('transliterate / latinKey', () => {
  it('Ромашка → Romashka', () => {
    expect(transliterate('Ромашка')).toBe('Romashka');
    expect(transliterate('щука ёж')).toBe('shchuka ezh');
  });
  it('варианты записи сходятся к одному ключу', () => {
    expect(latinKey('Алексей')).toBe(latinKey('Alexey'));
    expect(latinKey('Юрий')).toBe(latinKey('Yuriy'));
    expect(latinKey('Ромашка')).toBe(latinKey('romashka'));
  });
});

describe('nameSimilarity', () => {
  it('персона: порядок токенов не важен', () => {
    expect(nameSimilarity('Иванов Иван Иванович', 'Иван Иванович Иванов', 'person')).toBe(1);
  });
  it('персона: инициалы', () => {
    expect(nameSimilarity('Иванов И. И.', 'Иванов Иван Иванович', 'person')).toBeGreaterThanOrEqual(0.85);
  });
  it('персона: без отчества — похоже, только фамилия — нет', () => {
    expect(nameSimilarity('Иванов Иван', 'Иванов Иван Иванович', 'person')).toBeGreaterThanOrEqual(0.85);
    expect(nameSimilarity('Иванов', 'Иванов Иван Иванович', 'person')).toBeLessThan(0.85);
  });
  it('персона: опечатка и латиница', () => {
    expect(nameSimilarity('Иванов Иван', 'Ivanof Ivan', 'person')).toBeGreaterThanOrEqual(0.85);
  });
  it('персона: только инициалы без полного токена → 0', () => {
    expect(nameSimilarity('И. И.', 'Иван Иванович', 'person')).toBe(0);
  });
  it('персона: разные люди', () => {
    expect(nameSimilarity('Иванов Иван', 'Петров Пётр', 'person')).toBeLessThan(0.5);
  });
  it('организация: ООО «Ромашка» ~ Romashka LLC', () => {
    expect(nameSimilarity('ООО «Ромашка»', 'Romashka LLC', 'organization')).toBe(1);
    expect(nameSimilarity('Ромашка', 'Ромашки', 'organization')).toBeGreaterThanOrEqual(0.85);
  });
  it('организация: разные названия', () => {
    expect(nameSimilarity('Ромашка', 'Василёк', 'organization')).toBeLessThan(0.7);
  });
});
