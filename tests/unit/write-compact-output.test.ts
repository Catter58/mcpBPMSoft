/**
 * Текстовые ответы write-инструментов: компактная запись вместо полного JSON, «найдено по имени»,
 * превью массовых операций с названиями и удаление по подтверждённому плану.
 */

import { describe, it, expect } from 'vitest';
import { registerWriteTools } from '../../src/tools/write-tools.js';
import { LookupResolutionError } from '../../src/utils/errors.js';
import type { ServiceContainer } from '../../src/tools/init-tool.js';

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

const ID = '11111111-2222-3333-4444-555555555555';
const FULL_RECORD = {
  '@odata.etag': 'W/"1"',
  Id: ID,
  Name: 'Иванов Иван',
  Email: 'ivan@example.com',
  OwnerId: 'aaaaaaaa-0000-0000-0000-000000000009',
  OwnerName: 'Супервизор',
  Notes: '',
  Age: 0,
  IsNonActualEmail: false,
  AccountId: '00000000-0000-0000-0000-000000000000',
  BirthDate: '0001-01-01T00:00:00Z',
};
const FOUND = [
  { Id: 'aaaaaaaa-0000-0000-0000-000000000001', Name: 'Альфа' },
  { Id: 'aaaaaaaa-0000-0000-0000-000000000002', Name: 'Бета' },
];

interface Calls {
  getRecords: Array<{ $select?: string; $top?: number }>;
  deleted: string[];
  updated: Array<{ id: string; data: Record<string, unknown> }>;
}

function setup(opts: { ambiguous?: boolean; failUpdateIds?: string[]; failDeleteIds?: string[] } = {}): {
  handler: (name: string) => Handler;
  calls: Calls;
} {
  const calls: Calls = { getRecords: [], deleted: [], updated: [] };
  const odataClient = {
    async createRecord(_c: string, data: Record<string, unknown>) {
      return { ...FULL_RECORD, ...data };
    },
    async createRecordWithOutcome(_c: string, data: Record<string, unknown>) {
      return { record: await this.createRecord(_c, data), created: true };
    },
    async updateRecord(_c: string, id: string, data: Record<string, unknown>) {
      calls.updated.push({ id, data });
      if (opts.failUpdateIds?.includes(id)) throw new Error('update failed');
      return { ...FULL_RECORD, ...data };
    },
    async getRecord() {
      return FULL_RECORD;
    },
    async getRecords(_c: string, query: { $select?: string; $top?: number }) {
      calls.getRecords.push(query);
      return { value: FOUND };
    },
    async deleteRecord(_c: string, id: string) {
      calls.deleted.push(id);
      if (opts.failDeleteIds?.includes(id)) throw new Error('delete failed');
    },
  };
  const metadataManager = {
    async resolveCollectionReference(input: string) {
      return { name: input };
    },
    async getEntityMetadata() {
      return { properties: [{ name: 'Id' }, { name: 'Name' }], lookupFields: [] };
    },
  };
  const lookupResolver = {
    async resolveDataLookups(_c: string, data: Record<string, unknown>) {
      if (opts.ambiguous) {
        throw new LookupResolutionError('OwnerId', 'Иван', 2, [
          { id: 'o1', displayValue: 'Иван А' },
          { id: 'o2', displayValue: 'Иван Б' },
        ]);
      }
      if ('Owner' in data) {
        return {
          data: { OwnerId: 'o1' },
          notes: [{ field: 'OwnerId', input: data.Owner, id: 'o1', matched_value: 'Иван Иванов' }],
        };
      }
      return { data, notes: [] };
    },
    async resolve(_c: string, value: string) {
      return { resolved: true, id: ID, matchedValue: `${value} (полное)`, matchCount: 1, candidates: [] };
    },
  };
  const services = {
    config: { bpmsoft_url: 'https://crm.example.test', username: 'tester' },
    initialized: true,
    authManager: { async ensureAuthenticated() {} },
    odataClient,
    metadataManager,
    lookupResolver,
  } as unknown as ServiceContainer;

  const registered = new Map<string, Handler>();
  registerWriteTools(
    { registerTool: (name: string, _m: unknown, h: Handler) => registered.set(name, h) } as never,
    services
  );
  return {
    handler: (name) => async (args) => {
      const handler = registered.get(name)!;
      const execute =
        (name === 'bpm_update_by_filter' && args.expected_count !== undefined) ||
        (name === 'bpm_delete_by_filter' && args.confirm === true);
      const preview = await handler(execute ? { ...args, confirm: false } : args);
      if (execute && preview.structuredContent?.requires_confirmation)
        return handler({
          ...args,
          confirm: true,
          confirmation_token: preview.structuredContent.confirmation_token,
        });
      return preview;
    },
    calls,
  };
}

describe('bpm_create_record / bpm_update_record: компактный текст', () => {
  it('create: одна строка с именем и Id, затем только содержательные поля; structured — полная запись', async () => {
    const { handler } = setup();
    const res = await handler('bpm_create_record')({ collection: 'Contact', data: { Name: 'Иванов Иван' } });
    const text = res.content[0].text;
    expect(text.split('\n')[0]).toBe(`Запись создана в Contact: «Иванов Иван» (${ID})`);
    expect(text).toContain('  Email: ivan@example.com');
    expect(text).toContain('  OwnerName: Супервизор');
    for (const noise of ['@odata', 'OwnerId', 'Notes', 'Age', 'IsNonActualEmail', 'AccountId', 'BirthDate']) {
      expect(text).not.toContain(noise);
    }
    expect((res.structuredContent?.record as Record<string, unknown>).BirthDate).toBe(FULL_RECORD.BirthDate);
  });

  it('update по имени: сообщает, какую запись нашёл, и кладёт matched в structured', async () => {
    const { handler, calls } = setup();
    const res = await handler('bpm_update_record')({
      collection: 'Contact',
      id: 'Иванов',
      data: { Email: 'new@example.com' },
    });
    const text = res.content[0].text;
    expect(text).toContain(`Найдена запись по имени: «Иванов (полное)» (${ID})`);
    expect(text).toContain('Обновлённые поля: Email');
    expect(text).toContain('  Email: new@example.com');
    expect(text).not.toContain('{');
    expect(res.structuredContent?.matched).toBe('Иванов (полное)');
    expect(calls.updated[0].id).toBe(ID);
  });

  it('update по UUID: без строки про имя и без matched', async () => {
    const { handler } = setup();
    const res = await handler('bpm_update_record')({
      collection: 'Contact',
      id: ID,
      data: { Email: 'x@y.z' },
    });
    expect(res.content[0].text).not.toContain('Найдена запись по имени');
    expect(res.structuredContent?.matched).toBeUndefined();
  });
});

describe('bpm_delete_record: превью', () => {
  it('превью компактное и с matched, ничего не удаляет', async () => {
    const { handler, calls } = setup();
    const res = await handler('bpm_delete_record')({ collection: 'Contact', id: 'Иванов' });
    const text = res.content[0].text;
    expect(text).toContain('Найдена запись по имени');
    expect(text).toContain(`Будет удалена запись Contact: «Иванов Иван» (${ID})`);
    expect(text).not.toContain('@odata');
    expect(res.structuredContent?.matched).toBe('Иванов (полное)');
    expect(calls.deleted).toHaveLength(0);
  });
});

describe('bpm_update_by_filter: превью', () => {
  it('показывает «Имя (Id)» и уже разрешённые справочники', async () => {
    const { handler, calls } = setup();
    const res = await handler('bpm_update_by_filter')({
      collection: 'Contact',
      filter: "Name ne ''",
      data: { Owner: 'Иван' },
    });
    const text = res.content[0].text;
    expect(calls.getRecords[0].$select).toBe('Id,Name');
    expect(text).toContain('Альфа (aaaaaaaa-0000-0000-0000-000000000001)');
    expect(text).toContain('expected_count=2');
    expect(res.structuredContent?.names).toEqual(['Альфа', 'Бета']);
    expect(res.structuredContent?.resolved_lookups).toBeDefined();
    expect(calls.updated).toHaveLength(0);
  });

  it('неоднозначный справочник — ошибка уже на превью, до выборки записей', async () => {
    const { handler, calls } = setup({ ambiguous: true });
    const res = await handler('bpm_update_by_filter')({
      collection: 'Contact',
      filter: "Name ne ''",
      data: { Owner: 'Иван' },
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({
      code: 'lookup_ambiguous',
      candidates: expect.arrayContaining([{ id: 'o1', displayValue: 'Иван А' }]),
    });
    expect(calls.getRecords).toHaveLength(0);
  });

  it('все обновления упали → isError true', async () => {
    const { handler } = setup({ failUpdateIds: FOUND.map((r) => r.Id) });
    const res = await handler('bpm_update_by_filter')({
      collection: 'Contact',
      filter: "Name ne ''",
      data: { Email: 'x@y.z' },
      expected_count: 2,
    });
    expect(res.structuredContent?.succeeded).toEqual([]);
    expect(res.structuredContent?.failed).toHaveLength(1);
    expect(res.structuredContent?.outcomes).toEqual([
      expect.objectContaining({ state: 'failed' }),
      expect.objectContaining({ state: 'not_executed' }),
    ]);
    expect(res.isError).toBe(true);
  });

  it('часть обновлений упала → isError true', async () => {
    const { handler } = setup({ failUpdateIds: [FOUND[1].Id] });
    const res = await handler('bpm_update_by_filter')({
      collection: 'Contact',
      filter: "Name ne ''",
      data: { Email: 'x@y.z' },
      expected_count: 2,
    });
    expect(res.structuredContent?.succeeded).toEqual([FOUND[0].Id]);
    expect(res.structuredContent?.failed).toHaveLength(1);
    expect(res.isError).toBe(true);
  });

  it('ошибок нет → isError false', async () => {
    const { handler } = setup();
    const res = await handler('bpm_update_by_filter')({
      collection: 'Contact',
      filter: "Name ne ''",
      data: { Email: 'x@y.z' },
      expected_count: 2,
    });
    expect(res.structuredContent?.succeeded).toHaveLength(2);
    expect(res.structuredContent?.failed).toEqual([]);
    expect(res.isError).toBe(false);
  });
});

describe('bpm_delete_by_filter: подтверждение плана', () => {
  it('первое превью объясняет точный план и подтверждение; помощник теста подтверждает его', async () => {
    const { handler, calls } = setup();
    const del = handler('bpm_delete_by_filter');
    const preview = await del({ collection: 'Contact', filter: "Name ne ''" });
    expect(preview.content[0].text).toContain(
      'expected_count=2 для точного плана, затем confirm=true и confirmation_token'
    );
    expect(preview.content[0].text).toContain('Бета (aaaaaaaa-0000-0000-0000-000000000002)');
    expect(preview.structuredContent?.names).toEqual(['Альфа', 'Бета']);
    expect(calls.deleted).toHaveLength(0);

    const done = await del({ collection: 'Contact', filter: "Name ne ''", expected_count: 2, confirm: true });
    expect(done.isError).toBeFalsy();
    expect(calls.deleted).toEqual(FOUND.map((r) => r.Id));
  });

  it('expected_count без confirm — по-прежнему превью подтверждения с названиями', async () => {
    const { handler, calls } = setup();
    const res = await handler('bpm_delete_by_filter')({
      collection: 'Contact',
      filter: "Name ne ''",
      expected_count: 2,
    });
    expect(res.structuredContent?.requires_confirmation).toBe(true);
    expect(res.content[0].text).toContain('Альфа (');
    expect(calls.deleted).toHaveLength(0);
  });

  it('все удаления упали → isError true', async () => {
    const { handler } = setup({ failDeleteIds: FOUND.map((r) => r.Id) });
    const res = await handler('bpm_delete_by_filter')({
      collection: 'Contact',
      filter: "Name ne ''",
      expected_count: 2,
      confirm: true,
    });
    expect(res.structuredContent?.succeeded).toEqual([]);
    expect(res.structuredContent?.failed).toHaveLength(1);
    expect(res.structuredContent?.outcomes).toEqual([
      expect.objectContaining({ state: 'failed' }),
      expect.objectContaining({ state: 'not_executed' }),
    ]);
    expect(res.isError).toBe(true);
  });

  it('часть удалений упала → isError true', async () => {
    const { handler } = setup({ failDeleteIds: [FOUND[0].Id] });
    const res = await handler('bpm_delete_by_filter')({
      collection: 'Contact',
      filter: "Name ne ''",
      expected_count: 2,
      confirm: true,
    });
    expect(res.structuredContent?.succeeded).toEqual([]);
    expect(res.structuredContent?.outcomes).toEqual([
      expect.objectContaining({ state: 'failed' }),
      expect.objectContaining({ state: 'not_executed' }),
    ]);
    expect(res.structuredContent?.failed).toHaveLength(1);
    expect(res.isError).toBe(true);
  });

  it('ошибок нет → isError false', async () => {
    const { handler } = setup();
    const res = await handler('bpm_delete_by_filter')({
      collection: 'Contact',
      filter: "Name ne ''",
      expected_count: 2,
      confirm: true,
    });
    expect(res.structuredContent?.succeeded).toHaveLength(2);
    expect(res.structuredContent?.failed).toEqual([]);
    expect(res.isError).toBe(false);
  });
});
