import { describe, it, expect } from 'vitest';
import { MetadataManager } from '../../src/metadata/metadata-manager.js';
import {
  resolveSelect,
  enrichLookups,
  getDisplayColumn,
  displayKeyFor,
  planLookupExpand,
  flattenExpandedLookups,
  getRecordsWithLookupNames,
} from '../../src/utils/display.js';
import { BpmApiError } from '../../src/utils/errors.js';
import { SIMPLE_EDMX } from '../setup/fixtures/edmx.js';
import type { BpmConfig, ODataCollectionResponse } from '../../src/types/index.js';

const CONTACT_ID = '11111111-1111-1111-1111-111111111111';
const MOSCOW_ID = '22222222-2222-2222-2222-222222222222';
const PITER_ID = '33333333-3333-3333-3333-333333333333';

function makeCfg(): BpmConfig {
  return {
    bpmsoft_url: 'https://bpm.test',
    username: 'u',
    password: 'p',
    odata_version: 4,
    platform: 'net8',
    page_size: 100,
    max_batch_size: 100,
    lookup_cache_ttl: 300,
    request_timeout: 30000,
    max_file_size: 10 * 1024 * 1024,
  };
}

interface GetRecordsCall {
  collection: string;
  filter?: string;
  select?: string;
  expand?: string;
}

/** Стаб ODataClient: отдаёт EDMX-фикстуру и записи справочника City. */
function makeStubClient(responder: (collection: string, filter?: string) => Array<Record<string, unknown>>) {
  const calls: GetRecordsCall[] = [];
  return {
    calls,
    async getMetadataXml(): Promise<{ xml: string; notModified: boolean }> {
      return { xml: SIMPLE_EDMX, notModified: false };
    },
    async getRecords(
      collection: string,
      query?: { $filter?: string; $select?: string; $expand?: string }
    ): Promise<ODataCollectionResponse<Record<string, unknown>>> {
      calls.push({
        collection,
        filter: query?.$filter,
        select: query?.$select,
        expand: query?.$expand,
      });
      return { value: responder(collection, query?.$filter) };
    },
  };
}

function makeManager(client: unknown): MetadataManager {
  // httpClient не передаём — подтягивание локализованных caption'ов пропускается.
  return new MetadataManager(makeCfg(), client as never);
}

describe('resolveSelect', () => {
  it('без select ограничивает выборку до Id + колонки отображения', async () => {
    const mgr = makeManager(makeStubClient(() => []));
    expect(await resolveSelect(mgr, 'Contact')).toBe('Id,Name');
  });

  it("select='*' снимает проекцию — сервер вернёт все колонки", async () => {
    const mgr = makeManager(makeStubClient(() => []));
    expect(await resolveSelect(mgr, 'Contact', '*')).toBeUndefined();
  });

  it('явный список колонок сверяется со схемой и дополняется Id', async () => {
    const mgr = makeManager(makeStubClient(() => []));
    expect(await resolveSelect(mgr, 'Contact', 'Name,CityId')).toBe('Id,Name,CityId');
  });

  it('lookup по базовому имени приводится к FK-колонке', async () => {
    const mgr = makeManager(makeStubClient(() => []));
    expect(await resolveSelect(mgr, 'Contact', 'City')).toBe('Id,CityId');
  });

  it('несуществующая колонка отклоняется до запроса к BPMSoft', async () => {
    const mgr = makeManager(makeStubClient(() => []));
    await expect(resolveSelect(mgr, 'Contact', 'Id,НетТакойКолонки')).rejects.toThrow(/не найдено/i);
  });

  it('при недоступных метаданных возвращает undefined (прежнее поведение)', async () => {
    const broken = {
      async getMetadataXml(): Promise<{ xml: string; notModified: boolean }> {
        throw new Error('$metadata недоступен');
      },
    };
    expect(await resolveSelect(makeManager(broken), 'Contact')).toBeUndefined();
  });
});

describe('getDisplayColumn', () => {
  it('находит Name у известной коллекции', async () => {
    const mgr = makeManager(makeStubClient(() => []));
    expect(await getDisplayColumn(mgr, 'City')).toBe('Name');
  });

  it('возвращает null для неизвестной коллекции', async () => {
    const mgr = makeManager(makeStubClient(() => []));
    expect(await getDisplayColumn(mgr, 'НетТакой')).toBeNull();
  });
});

describe('displayKeyFor', () => {
  it('CityId → CityName (v4), City → CityName (v3)', () => {
    expect(displayKeyFor('CityId')).toBe('CityName');
    expect(displayKeyFor('City')).toBe('CityName');
  });
});

describe('enrichLookups', () => {
  it('подставляет имя связанной записи рядом с lookup-колонкой', async () => {
    const client = makeStubClient((collection) =>
      collection === 'City'
        ? [
            { Id: MOSCOW_ID, Name: 'Москва' },
            { Id: PITER_ID, Name: 'Санкт-Петербург' },
          ]
        : []
    );
    const mgr = makeManager(client);

    const records = await enrichLookups(
      [
        { Id: CONTACT_ID, Name: 'Иванов', CityId: MOSCOW_ID },
        { Id: '44444444-4444-4444-4444-444444444444', Name: 'Петров', CityId: PITER_ID },
      ],
      'Contact',
      { metadataManager: mgr, odataClient: client as never, odataVersion: 4 }
    );

    expect(records[0].CityName).toBe('Москва');
    expect(records[1].CityName).toBe('Санкт-Петербург');
    // Исходные поля сохранены
    expect(records[0].CityId).toBe(MOSCOW_ID);

    // Один запрос на справочник, не по записи
    const cityCalls = client.calls.filter((c) => c.collection === 'City');
    expect(cityCalls).toHaveLength(1);
    expect(cityCalls[0].select).toBe('Id,Name');
    expect(cityCalls[0].filter).toContain(`Id eq ${MOSCOW_ID}`);
  });

  it('не ходит в справочник, если lookup-колонок в выдаче нет', async () => {
    const client = makeStubClient(() => []);
    const mgr = makeManager(client);

    const records = await enrichLookups([{ Id: CONTACT_ID, Name: 'Иванов' }], 'Contact', {
      metadataManager: mgr,
      odataClient: client as never,
      odataVersion: 4,
    });

    expect(records[0]).not.toHaveProperty('CityName');
    expect(client.calls.filter((c) => c.collection === 'City')).toHaveLength(0);
  });

  it('не затирает уже присутствующий ключ с тем же именем', async () => {
    const client = makeStubClient((collection) =>
      collection === 'City' ? [{ Id: MOSCOW_ID, Name: 'Москва' }] : []
    );
    const mgr = makeManager(client);

    const records = await enrichLookups(
      [{ Id: CONTACT_ID, CityId: MOSCOW_ID, CityName: 'своё значение' }],
      'Contact',
      { metadataManager: mgr, odataClient: client as never, odataVersion: 4 }
    );

    expect(records[0].CityName).toBe('своё значение');
  });

  it('недоступный справочник не роняет выдачу', async () => {
    const client = {
      async getMetadataXml(): Promise<{ xml: string; notModified: boolean }> {
        return { xml: SIMPLE_EDMX, notModified: false };
      },
      async getRecords(): Promise<ODataCollectionResponse<Record<string, unknown>>> {
        throw new Error('500 из BPMSoft');
      },
    };
    const mgr = makeManager(client);

    const input = [{ Id: CONTACT_ID, CityId: MOSCOW_ID }];
    const records = await enrichLookups(input, 'Contact', {
      metadataManager: mgr,
      odataClient: client as never,
      odataVersion: 4,
    });

    expect(records[0].CityId).toBe(MOSCOW_ID);
    expect(records[0]).not.toHaveProperty('CityName');
  });

  it("в OData v3 GUID-ы уходят в фильтр в форме guid'...'", async () => {
    const client = makeStubClient((collection) =>
      collection === 'City' ? [{ Id: MOSCOW_ID, Name: 'Москва' }] : []
    );
    const mgr = makeManager(client);

    await enrichLookups([{ Id: CONTACT_ID, CityId: MOSCOW_ID }], 'Contact', {
      metadataManager: mgr,
      odataClient: client as never,
      odataVersion: 3,
    });

    const cityCall = client.calls.find((c) => c.collection === 'City');
    expect(cityCall?.filter).toBe(`Id eq guid'${MOSCOW_ID}'`);
  });
});

describe('planLookupExpand', () => {
  it('при проекции Id,Name lookup-полей нет — $expand не строится', async () => {
    const mgr = makeManager(makeStubClient(() => []));
    const plan = await planLookupExpand(mgr, 'Contact', 'Id,Name', undefined);
    expect(plan.fields).toHaveLength(0);
    expect(plan.expand).toBeUndefined();
  });

  it('выбранная FK-колонка разворачивается в навигацию с проекцией имени', async () => {
    const mgr = makeManager(makeStubClient(() => []));
    const plan = await planLookupExpand(mgr, 'Contact', 'Id,Name,CityId', undefined);
    expect(plan.expand).toBe('City($select=Name)');
    expect(plan.fields).toEqual([
      { field: 'CityId', nav: 'City', display: 'Name', key: 'CityName', added: true },
    ]);
  });

  it('без $select разворачиваются все lookup-колонки', async () => {
    const mgr = makeManager(makeStubClient(() => []));
    const plan = await planLookupExpand(mgr, 'Contact', undefined, undefined);
    expect(plan.fields.map((f) => f.field)).toEqual(['CityId']);
  });

  it('навигацию, которую разворачивает клиент, не дублируем', async () => {
    const mgr = makeManager(makeStubClient(() => []));
    const plan = await planLookupExpand(mgr, 'Contact', 'Id,CityId', 'City($select=Name,Code)');
    expect(plan.fields).toHaveLength(0);
    expect(plan.expand).toBe('City($select=Name,Code)');
  });
});

describe('flattenExpandedLookups', () => {
  const plan = {
    expand: 'City($select=Name)',
    fields: [{ field: 'CityId', nav: 'City', display: 'Name', key: 'CityName', added: true }],
  };

  it('вложенный объект схлопывается в плоский ключ и убирается из записи', () => {
    const [rec] = flattenExpandedLookups(
      [{ Id: CONTACT_ID, CityId: MOSCOW_ID, City: { Name: 'Москва' } }],
      plan
    );
    expect(rec.CityName).toBe('Москва');
    expect(rec).not.toHaveProperty('City');
    expect(rec.CityId).toBe(MOSCOW_ID);
  });

  it('пустая связь не создаёт ключ', () => {
    const [rec] = flattenExpandedLookups([{ Id: CONTACT_ID, CityId: null, City: null }], plan);
    expect(rec).not.toHaveProperty('CityName');
  });
});

describe('getRecordsWithLookupNames', () => {
  it('один запрос с $expand вместо запроса на каждый справочник', async () => {
    const client = makeStubClient(() => [{ Id: CONTACT_ID, CityId: MOSCOW_ID, City: { Name: 'Москва' } }]);
    const mgr = makeManager(client);

    const { records } = await getRecordsWithLookupNames(
      { metadataManager: mgr, odataClient: client as never, odataVersion: 4 },
      'Contact',
      { $select: 'Id,CityId' }
    );

    expect(records[0].CityName).toBe('Москва');
    const contactCalls = client.calls.filter((c) => c.collection === 'Contact');
    expect(contactCalls).toHaveLength(1);
    expect(client.calls.filter((c) => c.collection === 'City')).toHaveLength(0);
  });

  it('отказ сервера на $expand → повтор без него и добор имён запросами', async () => {
    const calls: Array<{ collection: string; expand?: string }> = [];
    const client = {
      async getMetadataXml(): Promise<{ xml: string; notModified: boolean }> {
        return { xml: SIMPLE_EDMX, notModified: false };
      },
      async getRecords(
        collection: string,
        query?: { $expand?: string; $filter?: string; $select?: string }
      ): Promise<ODataCollectionResponse<Record<string, unknown>>> {
        calls.push({ collection, expand: query?.$expand });
        if (query?.$expand) {
          // Так ведёт себя bpm9: 200 и обрыв тела вместо честного 4xx.
          throw new BpmApiError('Сетевая ошибка: terminated', 0);
        }
        if (collection === 'City') return { value: [{ Id: MOSCOW_ID, Name: 'Москва' }] };
        return { value: [{ Id: CONTACT_ID, CityId: MOSCOW_ID }] };
      },
    };
    const mgr = makeManager(client);

    const { records } = await getRecordsWithLookupNames(
      { metadataManager: mgr, odataClient: client as never, odataVersion: 4 },
      'Contact',
      { $select: 'Id,CityId' }
    );

    expect(records[0].CityName).toBe('Москва');
    expect(calls.map((c) => `${c.collection}:${c.expand ?? '-'}`)).toEqual([
      'Contact:City($select=Name)',
      'Contact:-',
      'City:-',
    ]);
  });

  it('resolve_lookups=false отключает и $expand, и добор имён', async () => {
    const client = makeStubClient(() => [{ Id: CONTACT_ID, CityId: MOSCOW_ID }]);
    const mgr = makeManager(client);

    const { records } = await getRecordsWithLookupNames(
      { metadataManager: mgr, odataClient: client as never, odataVersion: 4 },
      'Contact',
      { $select: 'Id,CityId' },
      { resolveLookups: false }
    );

    expect(records[0]).not.toHaveProperty('CityName');
    expect(client.calls.every((c) => c.expand === undefined)).toBe(true);
  });
});
