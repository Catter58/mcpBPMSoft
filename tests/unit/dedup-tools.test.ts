import { describe, it, expect } from 'vitest';
import { buildProfile, toDedupRecord, planFillFields } from '../../src/tools/dedup-tools.js';
import type { EntityMetadata, EntityProperty } from '../../src/types/index.js';

function meta(collection: string, props: Array<[string, string, string?]>): EntityMetadata {
  const properties = props.map(
    ([name, type, lookupCollection]) =>
      ({
        name,
        type,
        nullable: true,
        isLookup: Boolean(lookupCollection),
        lookupCollection,
      }) as EntityProperty
  );
  return { name: collection, collectionName: collection, properties, lookupFields: [], cachedAt: 0 };
}

const CONTACT = meta('Contact', [
  ['Id', 'Edm.Guid'],
  ['Name', 'Edm.String'],
  ['Email', 'Edm.String'],
  ['IsEmailConfirmed', 'Edm.Boolean'],
  ['DoNotUseEmail', 'Edm.Boolean'],
  ['Phone', 'Edm.String'],
  ['MobilePhone', 'Edm.String'],
  ['AccountId', 'Edm.Guid', 'Account'],
  ['BirthDate', 'Edm.DateTimeOffset'],
  ['JobTitle', 'Edm.String'],
  ['Age', 'Edm.Int32'],
  ['CreatedOn', 'Edm.DateTimeOffset'],
]);

describe('dedup-tools: профиль и записи', () => {
  it('профиль контакта находит почту, телефоны, контрагента и дату рождения, без флагов', () => {
    const profile = buildProfile('Contact', CONTACT, 'Name');
    expect(profile).toMatchObject({
      kind: 'person',
      nameField: 'Name',
      emailFields: ['Email'],
      phoneFields: ['Phone', 'MobilePhone'],
      accountField: 'AccountId',
      birthField: 'BirthDate',
    });
  });

  it('профиль контрагента — организация, сайт и ИНН из пользовательской колонки', () => {
    const account = meta('Account', [
      ['Id', 'Edm.Guid'],
      ['Name', 'Edm.String'],
      ['Web', 'Edm.String'],
      ['UsrInn', 'Edm.String'],
    ]);
    expect(buildProfile('Account', account, 'Name')).toMatchObject({
      kind: 'organization',
      websiteField: 'Web',
      innField: 'UsrInn',
    });
  });

  it('запись собирает телефоны и почту из полей и средств связи, пустые значения отбрасывает', () => {
    const profile = buildProfile('Contact', CONTACT, 'Name');
    const record = toDedupRecord(
      {
        Id: 'c1',
        Name: ' Иванов Иван ',
        Email: '',
        Phone: '+7 (916) 555-12-34',
        MobilePhone: '123',
        AccountId: '00000000-0000-0000-0000-000000000000',
        BirthDate: '0001-01-01T00:00:00Z',
        CreatedOn: '2026-09-01T00:00:00Z',
      },
      profile,
      ['ivan@gmail.com', '8 916 555 00 00', 'romashka.ru']
    );
    expect(record).toMatchObject({
      id: 'c1',
      kind: 'person',
      name: 'Иванов Иван',
      emails: ['ivan@gmail.com'],
      phones: ['+7 (916) 555-12-34', '8 916 555 00 00'],
      website: 'romashka.ru',
      accountId: undefined,
      birthDate: undefined,
    });
  });
});

describe('dedup-tools: planFillFields', () => {
  it('заполняет только пустые текстовые, ссылочные и датовые поля основной записи', () => {
    const fill = planFillFields(
      CONTACT,
      {
        Id: 'm',
        Name: 'Иванов',
        Email: '',
        JobTitle: 'Директор',
        AccountId: '00000000-0000-0000-0000-000000000000',
        Age: 0,
      },
      [
        {
          Id: 'd1',
          Name: 'Иван Иванов',
          Email: 'ivan@x.ru',
          JobTitle: 'Менеджер',
          AccountId: 'acc-1',
          Age: 40,
        },
        { Id: 'd2', Email: 'other@x.ru', Phone: '+7 916 000 00 00' },
      ]
    );
    expect(fill).toEqual({ Email: 'ivan@x.ru', AccountId: 'acc-1', Phone: '+7 916 000 00 00' });
  });
});
