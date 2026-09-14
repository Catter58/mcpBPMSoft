import { describe, it, expect } from 'vitest';
import { compileFilter, type Criterion } from '../../src/utils/filter-compiler.js';
import { resolveOrderBy, displayKeyFor } from '../../src/utils/display.js';
import { combineFilters } from '../../src/tools/_guards.js';
import { isMeMacro, meIdFor } from '../../src/utils/me-macro.js';
import { accumulate } from '../../src/tools/aggregate-tool.js';
import { UnknownFieldError } from '../../src/utils/errors.js';
import type { MetadataManager } from '../../src/metadata/metadata-manager.js';
import type { EntityProperty } from '../../src/types/index.js';

const ME = '410006e1-ca4e-4502-a9ec-e54d922d2c00';
const user = { userId: 'u-1', userName: 'Supervisor', contactId: ME };

function prop(name: string, type = 'Edm.String', lookupCollection?: string): EntityProperty {
  return {
    name,
    type,
    nullable: true,
    isLookup: Boolean(lookupCollection),
    lookupCollection,
    lookupDisplayColumn: 'Name',
  } as EntityProperty;
}

const COLLECTIONS: Record<string, EntityProperty[]> = {
  Activity: [
    prop('Id', 'Edm.Guid'),
    prop('Title'),
    prop('StartDate', 'Edm.DateTimeOffset'),
    prop('OwnerId', 'Edm.Guid', 'Contact'),
    prop('AccountId', 'Edm.Guid', 'Account'),
  ],
  Contact: [prop('Id', 'Edm.Guid'), prop('Name')],
  Account: [prop('Id', 'Edm.Guid'), prop('Name')],
};
const ALIASES: Record<string, string> = { ответственный: 'OwnerId', контрагент: 'AccountId' };

const metadataManager = {
  async getEntityMetadata(collection: string) {
    return {
      name: collection,
      collectionName: collection,
      properties: COLLECTIONS[collection],
      lookupFields: [],
    };
  },
  async getLookupInfo(collection: string, field: string) {
    const p = COLLECTIONS[collection].find((x) => x.name === field);
    return p?.lookupCollection ? { lookupCollection: p.lookupCollection, displayColumn: 'Name' } : null;
  },
  async resolveFieldReference(collection: string, query: string) {
    const name =
      ALIASES[query.toLowerCase()] ??
      COLLECTIONS[collection].find((p) => p.name.toLowerCase() === query.toLowerCase())?.name;
    return name ? { name } : { name: null, suggestions: [] };
  },
} as unknown as MetadataManager;

const compile = (criteria: Criterion[]) =>
  compileFilter(criteria, {
    collection: 'Activity',
    metadataManager,
    odataVersion: 4,
    timeZone: 'Europe/Moscow',
    currentUser: { get: async () => user },
  });

describe('«я» в criteria', () => {
  it('подставляет контакт текущего пользователя и сравнивает через навигацию', async () => {
    const { filter } = await compile([{ field: 'Ответственный', op: 'равно', value: 'я' }]);
    expect(filter).toBe(`Owner/Id eq ${ME}`);
  });

  it('ne по uuid — через not (Nav/Id eq): FK рвёт поток, Nav/Id ne теряет записи без связи', async () => {
    const { filter } = await compile([{ field: 'OwnerId', op: 'ne', value: ME }]);
    expect(filter).toBe(`not (Owner/Id eq ${ME})`);
  });

  it('распознаёт макрос и справочники', () => {
    expect(isMeMacro(' Я ')).toBe(true);
    expect(isMeMacro('Яна')).toBe(false);
    expect(meIdFor('ContactCollection', user)).toBe(ME);
    expect(meIdFor('SysAdminUnit', user)).toBe('u-1');
    expect(meIdFor('Account', user)).toBeNull();
  });
});

describe('даты без пояса — в поясе пользователя', () => {
  it('дата без времени с «равно» — сутки по Москве', async () => {
    const { filter } = await compile([{ field: 'StartDate', op: 'равно', value: '2026-09-14' }]);
    expect(filter).toBe('StartDate ge 2026-09-13T21:00:00Z and StartDate lt 2026-09-14T21:00:00Z');
  });

  it('время без смещения считается местным, с Z — как есть', async () => {
    expect((await compile([{ field: 'StartDate', op: 'больше', value: '2026-09-14 15:00' }])).filter).toBe(
      'StartDate gt 2026-09-14T12:00:00Z'
    );
    expect(
      (await compile([{ field: 'StartDate', op: 'больше', value: '2026-09-14T15:00:00Z' }])).filter
    ).toBe('StartDate gt 2026-09-14T15:00:00Z');
  });

  it('between по датам включает последний день целиком', async () => {
    const { filter } = await compile([
      { field: 'StartDate', op: 'между', value: '2026-09-01', value_to: '2026-09-14' },
    ]);
    expect(filter).toBe('StartDate ge 2026-08-31T21:00:00Z and StartDate lt 2026-09-14T21:00:00Z');
  });
});

describe('resolveOrderBy', () => {
  it('подписи в имена, lookup — в имя связанной записи, направление сохраняется', async () => {
    expect(await resolveOrderBy(metadataManager, 'Activity', 'Контрагент desc, title')).toBe(
      'Account/Name desc,Title'
    );
    expect(await resolveOrderBy(metadataManager, 'Activity', undefined)).toBeUndefined();
  });

  it('неизвестная колонка — ошибка с подсказками', async () => {
    await expect(resolveOrderBy(metadataManager, 'Activity', 'Zzz asc')).rejects.toBeInstanceOf(
      UnknownFieldError
    );
  });
});

describe('combineFilters', () => {
  it('склеивает непустые части через and', () => {
    expect(combineFilters('a eq 1', undefined, ' ', 'b eq 2')).toBe('(a eq 1) and (b eq 2)');
    expect(combineFilters('a eq 1')).toBe('a eq 1');
    expect(combineFilters(undefined, '')).toBeUndefined();
  });
});

describe('bpm_aggregate: accumulate', () => {
  it('группирует по lookup с именами и считает метрики, пропуская пустые значения', () => {
    const groups = new Map();
    const labelKey = displayKeyFor('StageId');
    const metrics = [{ op: 'sum' as const, field: 'Amount', label: 'sum(Amount)' }];
    const rows = [
      { StageId: 's1', [labelKey]: 'Анализ', Amount: 100 },
      { StageId: 's1', [labelKey]: 'Анализ', Amount: 50 },
      { StageId: 's2', [labelKey]: 'Победа', Amount: null },
      { StageId: null, Amount: 7 },
      { StageId: '00000000-0000-0000-0000-000000000000', Amount: 1 },
    ];
    for (const row of rows) accumulate(groups, row, 'StageId', labelKey, metrics);

    const byLabel = Object.fromEntries([...groups.values()].map((g) => [g.label, g]));
    expect(byLabel['Анализ'].count).toBe(2);
    expect(byLabel['Анализ'].sums.get('sum(Amount)')).toBe(150);
    expect(byLabel['Победа'].counts.get('sum(Amount)')).toBeUndefined();
    expect(byLabel['(пусто)'].key).toBeNull();
    expect(byLabel['(пусто)'].count).toBe(2);
  });
});
