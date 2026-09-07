import { describe, it, expect } from 'vitest';
import { CurrentUserService } from '../../src/user/current-user.js';
import { MetadataManager } from '../../src/metadata/metadata-manager.js';
import { compileFilter } from '../../src/utils/filter-compiler.js';
import { runWithAuth } from '../../src/auth/request-context.js';
import { calendarRange } from '../../src/utils/datetime.js';
import { SIMPLE_EDMX } from '../setup/fixtures/edmx.js';
import type { BpmConfig, HttpRequestOptions, HttpResponse } from '../../src/types/index.js';

const UNIT_ID = '7f3b869f-34f3-4f20-ab4d-7480a5fdf647';
const CONTACT_ID = '410006e1-ca4e-4502-a9ec-e54d922d2c00';

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

function makeHttp(responder: (opts: HttpRequestOptions) => unknown) {
  const requests: HttpRequestOptions[] = [];
  return {
    requests,
    async request<T>(options: HttpRequestOptions): Promise<HttpResponse<T>> {
      requests.push(options);
      return {
        status: 200,
        statusText: 'OK',
        headers: {},
        data: responder(options) as T,
        ok: true,
      };
    },
  };
}

const okRow = {
  rows: [
    {
      Id: UNIT_ID,
      Name: 'Supervisor',
      ContactId: CONTACT_ID,
      ContactName: 'Иванов Иван',
      ContactEmail: '',
      CultureName: 'ru-RU',
      TimeZoneId: '',
      UnitType: 4,
    },
  ],
  success: true,
};

describe('CurrentUserService', () => {
  it('спрашивает BPMSoft макросом текущего пользователя, а не гадает по сессиям', async () => {
    const http = makeHttp(() => okRow);
    const service = new CurrentUserService(makeCfg(), http as never);

    const user = await service.get();

    expect(user.userId).toBe(UNIT_ID);
    expect(user.contactId).toBe(CONTACT_ID);
    expect(user.contactName).toBe('Иванов Иван');
    expect(user.culture).toBe('ru-RU');

    const sent = http.requests[0];
    expect(sent.url).toContain('/0/DataService/json/SyncReply/SelectQuery');
    const body = sent.body as { rootSchemaName: string; filters: Record<string, never> };
    expect(body.rootSchemaName).toBe('SysAdminUnit');
    // фильтр — макрос, вычисляемый сервером в сессии вызывающего
    expect(JSON.stringify(body.filters)).toContain('"macrosType":1');
  });

  it('пустые ссылки BPMSoft не превращаются в мнимые значения', async () => {
    const http = makeHttp(() => ({
      rows: [{ Id: UNIT_ID, Name: 'Supervisor', ContactId: '00000000-0000-0000-0000-000000000000' }],
    }));
    const user = await new CurrentUserService(makeCfg(), http as never).get();
    expect(user.contactId).toBeUndefined();
    expect(user.contactEmail).toBeUndefined();
  });

  it('пустой ответ — явная ошибка, а не «пользователь без имени»', async () => {
    const http = makeHttp(() => ({ rows: [] }));
    await expect(new CurrentUserService(makeCfg(), http as never).get()).rejects.toThrow(
      /не удалось определить текущего пользователя/i
    );
  });

  it('кэш не пересекается между пользователями', async () => {
    let call = 0;
    const http = makeHttp(() => {
      call += 1;
      return {
        rows: [{ Id: UNIT_ID, Name: call === 1 ? 'Первый' : 'Второй', ContactId: CONTACT_ID }],
      };
    });
    const service = new CurrentUserService(makeCfg(), http as never);

    const auth = (csrf: string) => ({ csrfToken: csrf, cookies: new Map([['BPMSESSIONID', csrf]]) });
    const first = await runWithAuth(auth('token-a') as never, () => service.get());
    const firstAgain = await runWithAuth(auth('token-a') as never, () => service.get());
    const second = await runWithAuth(auth('token-b') as never, () => service.get());

    expect(first.userName).toBe('Первый');
    expect(firstAgain.userName).toBe('Первый'); // из кэша, повторного запроса нет
    expect(second.userName).toBe('Второй'); // другая сессия — свой запрос
    expect(http.requests).toHaveLength(2);
  });
});

describe('календарные операторы в criteria-DSL', () => {
  function makeManager(): MetadataManager {
    const client = {
      async getMetadataXml(): Promise<{ xml: string; notModified: boolean }> {
        return { xml: SIMPLE_EDMX, notModified: false };
      },
    };
    return new MetadataManager(makeCfg(), client as never);
  }

  it('«сегодня» превращается в полуинтервал по границам суток пояса', async () => {
    const result = await compileFilter([{ field: 'Name', op: 'сегодня' }], {
      collection: 'Contact',
      metadataManager: makeManager(),
      odataVersion: 4,
      timeZone: 'Europe/Moscow',
    });

    const range = calendarRange('today', 'Europe/Moscow');
    const from = range.from.toISOString().replace(/\.\d{3}Z$/, 'Z');
    const to = range.to.toISOString().replace(/\.\d{3}Z$/, 'Z');
    expect(result.filter).toBe(`Name ge ${from} and Name lt ${to}`);
  });

  it('английские синонимы периодов работают наравне с русскими', async () => {
    const ru = await compileFilter([{ field: 'Name', op: 'в этом месяце' }], {
      collection: 'Contact',
      metadataManager: makeManager(),
      odataVersion: 4,
      timeZone: 'Europe/Moscow',
    });
    const en = await compileFilter([{ field: 'Name', op: 'this_month' }], {
      collection: 'Contact',
      metadataManager: makeManager(),
      odataVersion: 4,
      timeZone: 'Europe/Moscow',
    });
    expect(ru.filter).toBe(en.filter);
  });

  it('разные пояса дают разные границы одних и тех же суток', async () => {
    const opts = { collection: 'Contact', metadataManager: makeManager(), odataVersion: 4 as const };
    const msk = await compileFilter([{ field: 'Name', op: 'сегодня' }], {
      ...opts,
      timeZone: 'Europe/Moscow',
    });
    const utc = await compileFilter([{ field: 'Name', op: 'сегодня' }], { ...opts, timeZone: 'UTC' });
    expect(msk.filter).not.toBe(utc.filter);
  });
});
