import { describe, it, expect, beforeEach } from 'vitest';
import { MetadataManager } from '../../src/metadata/metadata-manager.js';
import { compileFilter } from '../../src/utils/filter-compiler.js';
import { aliasCandidates } from '../../src/utils/ru-aliases.js';
import { resetServerCapabilities } from '../../src/utils/server-capabilities.js';
import { SIMPLE_EDMX } from '../setup/fixtures/edmx.js';
import type { BpmConfig } from '../../src/types/index.js';

const MOSCOW_ID = '22222222-2222-2222-2222-222222222222';

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

function makeManager(): MetadataManager {
  const client = {
    async getMetadataXml(): Promise<{ xml: string; notModified: boolean }> {
      return { xml: SIMPLE_EDMX, notModified: false };
    },
  };
  return new MetadataManager(makeCfg(), client as never);
}

async function compile(field: string, op: string, value?: unknown): Promise<string> {
  const result = await compileFilter([{ field, op, value }], {
    collection: 'Contact',
    metadataManager: makeManager(),
    odataVersion: 4,
  });
  return result.filter;
}

beforeEach(() => resetServerCapabilities());

describe('встроенный словарь русских подписей', () => {
  it('знает типовые колонки Creatio', () => {
    expect(aliasCandidates('Город')).toContain('CityId');
    expect(aliasCandidates('название')).toContain('Name');
    expect(aliasCandidates('Дата создания')).toContain('CreatedOn');
  });

  it('находит подпись внутри более длинной фразы', () => {
    expect(aliasCandidates('Дата создания записи')).toContain('CreatedOn');
  });

  it('незнакомую подпись не выдумывает', () => {
    expect(aliasCandidates('Квартальная маржинальность')).toEqual([]);
  });
});

describe('lookup в criteria-DSL', () => {
  it('русская подпись + текст → сравнение с именем связанной записи', async () => {
    expect(await compile('Город', 'равно', 'Москва')).toBe("City/Name eq 'Москва'");
  });

  it('английское имя FK-колонки работает так же', async () => {
    expect(await compile('CityId', 'равно', 'Москва')).toBe("City/Name eq 'Москва'");
  });

  it('подстрока по lookup идёт по имени справочника', async () => {
    expect(await compile('Город', 'содержит', 'Моск')).toBe("contains(tolower(City/Name), 'моск')");
  });

  it('UUID сравнивается с самой FK-колонкой — так дешевле для сервера', async () => {
    expect(await compile('Город', 'равно', MOSCOW_ID)).toBe(`CityId eq ${MOSCOW_ID}`);
  });

  it('пустота проверяется на FK-колонке, а не на навигации', async () => {
    expect(await compile('Город', 'пусто')).toBe('CityId eq null');
    expect(await compile('Город', 'не пусто')).toBe('CityId ne null');
  });

  it('список текстовых значений разворачивается по имени', async () => {
    const result = await compileFilter([{ field: 'Город', op: 'в списке', value: ['Москва', 'Тверь'] }], {
      collection: 'Contact',
      metadataManager: makeManager(),
      odataVersion: 4,
    });
    expect(result.filter).toBe("(City/Name eq 'Москва' or City/Name eq 'Тверь')");
  });

  it('предупреждение про «достаньте UUID» не выдаётся, когда сравнили по имени', async () => {
    const result = await compileFilter([{ field: 'Город', op: 'равно', value: 'Москва' }], {
      collection: 'Contact',
      metadataManager: makeManager(),
      odataVersion: 4,
    });
    expect(result.warnings).toEqual([]);
    expect(result.used_fields[0]).toMatchObject({ input: 'Город', resolved: 'City/Name' });
  });

  it('обычная колонка навигацией не подменяется', async () => {
    expect(await compile('Название', 'равно', 'Иванов')).toBe("Name eq 'Иванов'");
  });
});
