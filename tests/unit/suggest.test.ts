import { expect, it } from 'vitest';
import { suggestFields } from '../../src/utils/suggest.js';

it('offers both specific phone fields for a general caption', () => {
  expect(
    suggestFields('Телефон', [
      { name: 'Phone', caption: 'Рабочий телефон' },
      { name: 'MobilePhone', caption: 'Мобильный телефон' },
      { name: 'Name', caption: 'ФИО' },
    ])
  ).toEqual(['Phone [Рабочий телефон]', 'MobilePhone [Мобильный телефон]']);
});
