/**
 * Текстовые ответы write-инструментов: компактная запись вместо полного JSON, «найдено по имени»,
 * превью массовых операций с названиями и удаление по фильтру за два вызова.
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

function setup(opts: { ambiguous?: boolean } = {}): { handler: (name: string) => Handler; calls: Calls } {
  const calls: Calls = { getRecords: [], deleted: [], updated: [] };
  const odataClient = {
    async createRecord(_c: string, data: Record<string, unknown>) {
      return { ...FULL_RECORD, ...data };
    },
    async updateRecord(_c: string, id: string, data: Record<string, unknown>) {
      calls.updated.push({ id, data });
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
  return { handler: (name) => registered.get(name)!, calls };
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
    expect(res.content[0].text).toContain('Неоднозначное значение');
    expect(calls.getRecords).toHaveLength(0);
  });
});

describe('bpm_delete_by_filter: за два вызова', () => {
  it('первое превью называет оба условия; второй вызов с ними удаляет сразу', async () => {
    const { handler, calls } = setup();
    const del = handler('bpm_delete_by_filter');
    const preview = await del({ collection: 'Contact', filter: "Name ne ''" });
    expect(preview.content[0].text).toContain('expected_count=2 и confirm=true');
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
});
