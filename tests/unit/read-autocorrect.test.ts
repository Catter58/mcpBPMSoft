import { describe, it, expect, beforeAll } from 'vitest';
import { MetadataManager, singularCaptionCandidates } from '../../src/metadata/metadata-manager.js';
import { damerauLevenshtein, uniqueClosest } from '../../src/utils/suggest.js';
import { compileCriteria } from '../../src/tools/_guards.js';
import { registerReadTools } from '../../src/tools/read-tools.js';
import { UnknownFieldError } from '../../src/utils/errors.js';
import type { ServiceContainer } from '../../src/tools/init-tool.js';
import type { BpmConfig, ODataVersion } from '../../src/types/index.js';
import { SIMPLE_EDMX } from '../setup/fixtures/edmx.js';

const ID = '11111111-2222-3333-4444-555555555555';

beforeAll(() => {
  process.env.BPMSOFT_METADATA_CACHE = 'off';
});

function makeManager(version: ODataVersion = 4, xml = SIMPLE_EDMX): MetadataManager {
  const cfg = {
    bpmsoft_url: 'https://bpm.test',
    odata_version: version,
    platform: version === 3 ? 'netframework' : 'net8',
    lookup_cache_ttl: 300,
  } as BpmConfig;
  const odataClient = { getMetadataXml: async () => ({ xml }) };
  // SysSchema знает только подпись «Контакт»; всё остальное — пусто.
  const httpClient = {
    request: async ({ url }: { url: string }) => ({
      data: {
        value: decodeURIComponent(url).includes("Caption eq 'Контакт'")
          ? [{ Name: 'Contact', Caption: 'Контакт' }]
          : [],
      },
    }),
  };
  return new MetadataManager(cfg, odataClient as never, httpClient as never);
}

describe('suggest: однозначная опечатка', () => {
  it('перестановка соседних букв стоит 1', () => {
    expect(damerauLevenshtein('Nmae', 'Name')).toBe(1);
  });

  it('неоднозначность и слишком короткий запрос не угадываются', () => {
    const c = (v: string) => ({ value: v, keys: [v] });
    expect(uniqueClosest('Nmae', [c('Name'), c('Id')])).toBe('Name');
    expect(uniqueClosest('Cod', [c('Code'), c('Cid')])).toBeNull();
    expect(uniqueClosest('Nm', [c('Name')])).toBeNull();
    expect(uniqueClosest('Zzzzzz', [c('Name')])).toBeNull();
  });

  it('множественное число подписи → варианты единственного', () => {
    expect(singularCaptionCandidates('Контакты')).toContain('Контакт');
    expect(singularCaptionCandidates('Задачи')).toContain('Задача');
    expect(singularCaptionCandidates('Активности')).toContain('Активность');
  });
});

describe('MetadataManager: автоисправление коллекций', () => {
  it('v4: ContactCollection → Contact (всегда, это та же сущность)', async () => {
    expect(await makeManager().resolveCollectionReference('ContactCollection')).toEqual({
      name: 'Contact',
      autoCorrected: true,
    });
  });

  it('v3: Contact → ContactCollection', async () => {
    const v3 = SIMPLE_EDMX.replace('EntitySet Name="Contact"', 'EntitySet Name="ContactCollection"');
    expect(await makeManager(3, v3).resolveCollectionReference('Contact')).toEqual({
      name: 'ContactCollection',
      autoCorrected: true,
    });
  });

  it('«Контакты» и опечатка — только с autoCorrect', async () => {
    const mm = makeManager();
    expect(await mm.resolveCollectionReference('Контакты', { autoCorrect: true })).toEqual({
      name: 'Contact',
      autoCorrected: true,
    });
    expect((await mm.resolveCollectionReference('Контакты')).name).toBeNull();
    expect((await mm.resolveCollectionReference('Contcat', { autoCorrect: true })).name).toBe('Contact');
    expect((await mm.resolveCollectionReference('Contcat')).name).toBeNull();
  });
});

describe('MetadataManager: автоисправление полей', () => {
  it('исправляет только с autoCorrect', async () => {
    const mm = makeManager();
    expect(await mm.resolveFieldReference('Contact', 'Nmae', { autoCorrect: true })).toEqual({
      name: 'Name',
      autoCorrected: true,
    });
    expect(await mm.resolveFieldReference('Contact', 'Ctiy', { autoCorrect: true })).toEqual({
      name: 'CityId',
      autoCorrected: true,
    });
    expect((await mm.resolveFieldReference('Contact', 'Nmae')).name).toBeNull();
  });

  it('criteria: чтение исправляет с заметкой, путь записи (без флага) по-прежнему падает', async () => {
    const services = {
      metadataManager: makeManager(),
      config: { odata_version: 4 },
      currentUser: { get: async () => ({}) },
    } as unknown as ServiceContainer;
    const criteria = [{ field: 'Nmae', op: 'eq', value: 'Иван' }] as never;

    const read = await compileCriteria(services, 'Contact', criteria, undefined, { autoCorrect: true });
    expect(read.filter).toBe("Name eq 'Иван'");
    expect(read.warnings[0]).toContain('«Nmae» → Name');

    await expect(compileCriteria(services, 'Contact', criteria)).rejects.toBeInstanceOf(UnknownFieldError);
  });
});

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
}>;

function readTools(odataClient: Record<string, unknown>) {
  const handlers = new Map<string, Handler>();
  const server = { registerTool: (name: string, _cfg: unknown, h: Handler) => handlers.set(name, h) };
  const services = {
    initialized: true,
    authManager: { ensureAuthenticated: async () => undefined },
    metadataManager: makeManager(),
    odataClient,
    config: { odata_version: 4 },
    currentUser: { get: async () => ({}) },
  } as unknown as ServiceContainer;
  registerReadTools(server as never, services);
  return handlers;
}

describe('read-tools: запись целиком и заметки об исправлениях', () => {
  it('bpm_get_record без select берёт все колонки с именами lookup, текст — без пустых полей', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const handlers = readTools({
      getRecord: async (_c: string, _id: string, query: Record<string, unknown>) => {
        calls.push(query);
        return { Id: ID, Name: 'Иван', CityId: ID, City: { Name: 'Москва' }, Notes: '' };
      },
    });
    const result = await handlers.get('bpm_get_record')!({ collection: 'ContactCollection', id: ID });

    expect(calls[0].$select).toBeUndefined();
    expect(calls[0].$expand).toBe('City($select=Name)');
    const text = result.content[0].text;
    expect(text).toContain('Коллекция «ContactCollection» → Contact');
    expect(text).toContain('CityName: Москва');
    expect(text).not.toContain('Notes');
    expect(text).not.toContain(`CityId`);
    expect(result.structuredContent?.record).toMatchObject({ Notes: '', CityId: ID });
    expect(result.structuredContent?.warnings).toEqual(['Коллекция «ContactCollection» → Contact']);
  });

  it('bpm_get_records: опечатка в select исправляется и попадает в warnings', async () => {
    const handlers = readTools({
      getRecords: async () => ({ value: [{ Id: ID, Name: 'Иван' }] }),
    });
    const result = await handlers.get('bpm_get_records')!({ collection: 'Contact', select: 'Nmae' });
    expect(result.structuredContent?.warnings).toEqual(['Поле «Nmae» → Name (исправлена опечатка)']);
    expect(result.content[0].text).toContain(`Id=${ID}; Name=Иван`);
  });
});
