import { describe, it, expect } from 'vitest';
import { splitAgenda, registerMyAgendaTool, type AgendaItem } from '../../src/workflows/my-agenda.js';
import { registerRecordCardTool } from '../../src/tools/record-card-tool.js';
import type { ServiceContainer } from '../../src/tools/init-tool.js';
import { compactRecord } from '../../src/utils/compact.js';

const UUID = '11111111-2222-3333-4444-555555555555';

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

function fakeServer() {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool(name: string, _meta: unknown, handler: Handler) {
      handlers.set(name, handler);
    },
  };
  return { handlers, server };
}

const item = (id: string, due: string | null): AgendaItem => ({
  id,
  title: id,
  due,
  start: null,
  status: null,
  category: null,
});

describe('bpm_my_agenda: splitAgenda', () => {
  it('делит по сроку относительно «сейчас» и конца сегодняшнего дня', () => {
    const now = new Date('2026-09-14T09:00:00Z'); // 12:00 по Москве
    const todayEnd = new Date('2026-09-14T21:00:00Z'); // полночь по Москве
    const result = splitAgenda(
      [
        item('вчера', '2026-09-13T10:00:00Z'),
        item('утром сегодня', '2026-09-14T06:00:00Z'),
        item('вечером сегодня', '2026-09-14T18:00:00Z'),
        item('завтра', '2026-09-15T08:00:00Z'),
        item('без срока', null),
      ],
      now,
      todayEnd
    );
    expect(result.overdue.map((i) => i.id)).toEqual(['вчера', 'утром сегодня']);
    expect(result.today.map((i) => i.id)).toEqual(['вечером сегодня']);
    expect(result.upcoming.map((i) => i.id)).toEqual(['завтра', 'без срока']);
  });
});

describe('bpm_record_card: compactRecord', () => {
  it('оставляет только заполненные поля без служебных', () => {
    expect(
      compactRecord({
        '@odata.context': 'x',
        Id: '410006e1-ca4e-4502-a9ec-e54d922d2c00',
        Name: 'Supervisor',
        Email: '',
        OwnerId: '00000000-0000-0000-0000-000000000000',
        AccountId: 'c131eaff-d637-4863-bc64-363ff8a4bc4d',
        AccountName: 'ООО «Ромашка»',
        ProcessListeners: 0,
        Notes: null,
        DoNotUseEmail: false,
        DoNotUseSms: true,
        Age: 0,
        BirthDate: '0001-01-01T00:00:00Z',
        TypeId: '60733efc-f36b-1410-a883-16d83cab0980',
        Account: { Name: 'ООО «Ромашка»' },
      })
    ).toEqual({
      Id: '410006e1-ca4e-4502-a9ec-e54d922d2c00',
      Name: 'Supervisor',
      AccountName: 'ООО «Ромашка»',
      DoNotUseSms: true,
      TypeId: '60733efc-f36b-1410-a883-16d83cab0980',
    });
  });
});

function recordCardServices(opts: { withActivity: boolean; activityThrows?: boolean }): ServiceContainer {
  const properties: Record<string, Array<Record<string, unknown>>> = {
    Contact: [{ name: 'Name', isLookup: false }],
    Activity: [
      { name: 'ContactId', isLookup: true, lookupCollection: 'Contact', lookupNavProperty: 'Contact' },
    ],
  };
  const sets = opts.withActivity ? ['Contact', 'Activity'] : ['Contact'];
  return {
    config: { url: 'https://bpm.test', odata_version: 4, platform: 'net8', max_file_size: 1024 },
    authManager: { async ensureAuthenticated() {} },
    metadataManager: {
      async resolveCollectionReference(n: string) {
        return { name: n };
      },
      async getEntityMetadata(c: string) {
        return { name: c, properties: properties[c] ?? [] };
      },
      async getEntitySets() {
        return sets.map((name) => ({ name }));
      },
    },
    odataClient: {
      async getRecord() {
        return { Id: UUID, Name: 'Иван' };
      },
      async getRecords(c: string) {
        if (c === 'Activity' && opts.activityThrows) throw new Error('boom');
        return { value: [] };
      },
    },
    lookupResolver: {
      async resolve() {
        return { resolved: false };
      },
    },
    initialized: true,
  } as unknown as ServiceContainer;
}

async function runRecordCard(services: ServiceContainer, args: Record<string, unknown>): Promise<ToolResult> {
  const { server, handlers } = fakeServer();
  registerRecordCardTool(server as never, services);
  return handlers.get('bpm_record_card')!(args);
}

describe('bpm_record_card: isError', () => {
  it('раздел пропущен из-за ошибки → isError true', async () => {
    const r = await runRecordCard(recordCardServices({ withActivity: true, activityThrows: true }), {
      collection: 'Contact',
      id: UUID,
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('Пропущено');
  });

  it('разделы отсутствуют/пусты без ошибок → isError false', async () => {
    const r = await runRecordCard(recordCardServices({ withActivity: false }), {
      collection: 'Contact',
      id: UUID,
    });
    expect(r.isError).toBe(false);
    expect(r.content[0].text).not.toContain('Пропущено');
  });
});

function agendaServices(opts: { opportunityThrows?: boolean }): ServiceContainer {
  return {
    config: { url: 'https://bpm.test', odata_version: 4, platform: 'net8', max_file_size: 1024 },
    authManager: { async ensureAuthenticated() {} },
    currentUser: {
      async get() {
        return { contactId: UUID, contactName: 'Иван', userName: 'ivan', timeZoneId: 'Europe/Moscow' };
      },
    },
    metadataManager: {
      async getEntityMetadata(c: string) {
        return { name: c, properties: [] };
      },
    },
    odataClient: {
      async getRecords(c: string) {
        if (c === 'Opportunity' && opts.opportunityThrows) throw new Error('boom');
        return { value: [] };
      },
    },
    initialized: true,
  } as unknown as ServiceContainer;
}

async function runAgenda(services: ServiceContainer, args: Record<string, unknown>): Promise<ToolResult> {
  const { server, handlers } = fakeServer();
  registerMyAgendaTool(server as never, services);
  return handlers.get('bpm_my_agenda')!(args);
}

describe('bpm_my_agenda: isError', () => {
  it('раздел сделок не загрузился → isError true', async () => {
    const r = await runAgenda(agendaServices({ opportunityThrows: true }), { stale_days: 30 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('Сделки не получены');
  });

  it('пустая повестка без ошибок → isError false', async () => {
    const r = await runAgenda(agendaServices({}), {});
    expect(r.isError).toBe(false);
    const sc = r.structuredContent as { counts: { overdue: number; today: number; upcoming: number } };
    expect(sc.counts).toEqual({ overdue: 0, today: 0, upcoming: 0 });
  });
});
