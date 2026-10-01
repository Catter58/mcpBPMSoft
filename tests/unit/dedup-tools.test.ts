import { describe, it, expect } from 'vitest';
import {
  buildProfile,
  toDedupRecord,
  planFillFields,
  registerDedupTools,
} from '../../src/tools/dedup-tools.js';
import type { ServiceContainer } from '../../src/tools/init-tool.js';
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

interface MergeResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}
type MergeHandler = (args: Record<string, unknown>) => Promise<MergeResult>;
type MergeResultBody = { repointed: number; failed: unknown[]; deleted: string[] };

const MASTER = 'aaaaaaaa-0000-0000-0000-000000000001';
const DUP = 'aaaaaaaa-0000-0000-0000-000000000002';
const REF_1 = 'bbbbbbbb-0000-0000-0000-000000000001';
const REF_2 = 'bbbbbbbb-0000-0000-0000-000000000002';

function setupMerge(
  opts: {
    refCount?: number;
    refRows?: Array<{ Id: string }>;
    failRepointIds?: string[];
    countFails?: boolean;
  } = {}
): MergeHandler {
  const graph = new Map<string, Array<{ from: string; field: string; nav: string | null }>>();
  graph.set('Contact', [{ from: 'Activity', field: 'ContactId', nav: 'Contact' }]);
  const services = {
    initialized: true,
    config: { odata_version: 4 },
    authManager: { ensureAuthenticated: async () => undefined },
    metadataManager: {
      resolveCollectionReference: async (c: string) => ({ name: c }),
      getEntityMetadata: async () => ({
        name: 'Contact',
        collectionName: 'Contact',
        properties: [
          { name: 'Id', type: 'Edm.Guid', nullable: false, isLookup: false },
          { name: 'Name', type: 'Edm.String', nullable: true, isLookup: false },
        ],
        lookupFields: [],
        cachedAt: 0,
      }),
      getLookupGraph: async () => ({ incoming: graph, outgoing: new Map() }),
      getEntitySets: async () => [],
    },
    lookupResolver: {
      resolve: async () => ({ resolved: false, matchCount: 0, candidates: [] }),
    },
    odataClient: {
      getRecord: async (_c: string, id: string) => ({ Id: id, Name: '' }),
      getCount: async () => {
        if (opts.countFails) throw new Error('count down');
        return opts.refCount ?? 0;
      },
      getRecords: async () => {
        if (opts.countFails) throw new Error('count down');
        return { value: opts.refRows ?? [] };
      },
      updateRecord: async (_c: string, id: string) => {
        if (opts.failRepointIds?.includes(id)) throw new Error('repoint down');
        return { Id: id };
      },
      deleteRecord: async () => undefined,
    },
  } as unknown as ServiceContainer;

  const handlers = new Map<string, MergeHandler>();
  registerDedupTools(
    { registerTool: (name: string, _m: unknown, h: MergeHandler) => handlers.set(name, h) } as never,
    services
  );
  return handlers.get('bpm_merge_duplicates')!;
}

function mergeArgs(expected_references: number): Record<string, unknown> {
  return {
    collection: 'Contact',
    master_id: MASTER,
    duplicate_ids: [DUP],
    confirm: true,
    expected_references,
  };
}

describe('bpm_merge_duplicates: isError отражает любую ошибку', () => {
  it('перепривязано всё, ошибок нет → isError false', async () => {
    const handler = setupMerge({ refCount: 2, refRows: [{ Id: REF_1 }, { Id: REF_2 }] });
    const res = await handler(mergeArgs(2));
    const result = res.structuredContent?.result as MergeResultBody;
    expect(result.repointed).toBe(2);
    expect(result.failed).toEqual([]);
    expect(result.deleted).toEqual([DUP]);
    expect(res.isError).toBe(false);
  });

  it('часть ссылок не перепривязана → isError true', async () => {
    const handler = setupMerge({
      refCount: 2,
      refRows: [{ Id: REF_1 }, { Id: REF_2 }],
      failRepointIds: [REF_2],
    });
    const res = await handler(mergeArgs(2));
    const result = res.structuredContent?.result as MergeResultBody;
    expect(result.repointed).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(res.isError).toBe(true);
  });

  it('ни одна ссылка не перепривязана (все упали) → isError true', async () => {
    const handler = setupMerge({
      refCount: 2,
      refRows: [{ Id: REF_1 }, { Id: REF_2 }],
      failRepointIds: [REF_1, REF_2],
    });
    const res = await handler(mergeArgs(2));
    const result = res.structuredContent?.result as MergeResultBody;
    expect(result.repointed).toBe(0);
    expect(result.failed).toHaveLength(2);
    expect(res.isError).toBe(true);
  });

  it('ссылки есть, но не перепривязано ничего и ошибок нет → isError true', async () => {
    const handler = setupMerge({ refCount: 2, refRows: [] });
    const res = await handler(mergeArgs(2));
    const result = res.structuredContent?.result as MergeResultBody;
    expect(result.repointed).toBe(0);
    expect(result.failed).toEqual([]);
    expect(res.isError).toBe(true);
  });

  it('таблицы со ссылками не читаются → isError true', async () => {
    const handler = setupMerge({ countFails: true });
    const res = await handler(mergeArgs(0));
    expect((res.structuredContent?.count_failures as unknown[]).length).toBeGreaterThan(0);
    expect(res.isError).toBe(true);
  });
});
