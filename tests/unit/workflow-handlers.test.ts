/**
 * Unit tests for workflow tool handlers (bpm_set_status, bpm_register_contact,
 * bpm_log_activity). Tools are registered on a FakeServer that captures the
 * handler closure; services are lightweight stubs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerSetStatusTool } from '../../src/workflows/set-status.js';
import { registerRegisterContactTool } from '../../src/workflows/register-contact.js';
import { registerLogActivityTool } from '../../src/workflows/log-activity.js';
import { findOrCreate } from '../../src/workflows/find-or-create.js';
import type { ServiceContainer } from '../../src/tools/init-tool.js';
import type { EntityMetadata, EntityProperty, LookupResult } from '../../src/types/index.js';
import { LookupResolutionError } from '../../src/utils/errors.js';
import { LookupResolver } from '../../src/lookup/lookup-resolver.js';

type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;

const STATUS_DONE = 'aaaaaaaa-1111-4111-8111-111111111111';
const CONTACT_EXISTING = 'bbbbbbbb-2222-4222-8222-222222222222';
const ACCOUNT_EXISTING = 'cccccccc-3333-4333-8333-333333333333';
const CURRENT_CONTACT = 'dddddddd-4444-4444-8444-444444444444';
const CURRENT_USER = 'eeeeeeee-5555-4555-8555-555555555555';
const CREATED = 'ffffffff-6666-4666-8666-666666666666';
const CALL_CATEGORY_CALL = 'e52bd583-7825-e011-8165-00155d043204';
const CALL_CATEGORY_TASK = '03df85bf-6b19-4dea-8463-d5d49b80bb28';

function str(name: string): EntityProperty {
  return { name, type: 'Edm.String', nullable: true, isLookup: false };
}

function lookup(name: string, lookupCollection: string): EntityProperty {
  return {
    name,
    type: 'Edm.Guid',
    nullable: true,
    isLookup: true,
    lookupCollection,
    lookupDisplayColumn: 'Name',
  };
}

function meta(name: string, properties: EntityProperty[]): EntityMetadata {
  return {
    name,
    collectionName: name,
    properties: [{ name: 'Id', type: 'Edm.Guid', nullable: false, isLookup: false }, ...properties],
    lookupFields: properties.filter((p) => p.isLookup).map((p) => p.name),
    cachedAt: Date.now(),
  };
}

const METAS: Record<string, EntityMetadata> = {
  Contact: meta('Contact', [
    { ...str('Name'), required: true, requirementSource: 'entity_schema_designer' },
    str('Email'),
    str('JobTitle'),
    lookup('JobId', 'Job'),
    lookup('AccountId', 'Account'),
  ]),
  Account: meta('Account', [str('Name')]),
  Activity: meta('Activity', [
    { ...str('Title'), required: true, requirementSource: 'entity_schema_designer' },
    { ...str('StartDate'), type: 'Edm.DateTimeOffset' },
    { ...str('DueDate'), type: 'Edm.DateTimeOffset' },
    lookup('OwnerId', 'Contact'),
    {
      ...lookup('TypeId', 'ActivityType'),
      defaultHint: {
        source: 'constant',
        providedByServer: true,
        value: 'fbe0acdc-cfc0-df11-b00f-001d60e938c6',
      },
    },
    lookup('ActivityCategoryId', 'ActivityCategory'),
    lookup('AccountId', 'Account'),
    lookup('StatusId', 'ActivityStatus'),
    lookup('EmailSendStatusId', 'EmailSendStatus'),
  ]),
  ActivityCategory: meta('ActivityCategory', [str('Name'), lookup('ActivityTypeId', 'ActivityType')]),
};

interface Stub {
  services: ServiceContainer;
  created: Array<{ collection: string; data: Record<string, unknown> }>;
  updated: Array<{ collection: string; id: string; data: Record<string, unknown> }>;
  queries: Array<{ collection: string; filter?: string }>;
}

function notFound(value: string): LookupResult {
  return { resolved: false, searchValue: value, matchCount: 0, candidates: [] };
}

function found(id: string, value: string): LookupResult {
  return { resolved: true, id, searchValue: value, matchCount: 1, candidates: [{ id, displayValue: value }] };
}

function buildStub(
  lookups: Record<string, LookupResult>,
  records: (collection: string, filter?: string) => Array<Record<string, unknown>> = () => []
): Stub {
  const stub: Stub = { services: null!, created: [], updated: [], queries: [] };
  const metadataManager = {
    async resolveCollectionReference(q: string) {
      return METAS[q] ? { name: q } : { name: null, suggestions: [] };
    },
    async resolveFieldReference(collection: string, q: string) {
      const props = METAS[collection].properties;
      const hit = props.find((p) => p.name === q) ?? props.find((p) => p.name === `${q}Id`);
      return hit ? { name: hit.name } : { name: null, suggestions: [] };
    },
    async getEntityMetadata(collection: string) {
      return METAS[collection];
    },
    async getLookupInfo(collection: string, field: string) {
      const p = METAS[collection].properties.find((x) => x.name === field);
      return p?.isLookup ? { lookupCollection: p.lookupCollection!, displayColumn: 'Name' } : null;
    },
  };
  const odataClient = {
    async getRecords(collection: string, query?: { $filter?: string }) {
      stub.queries.push({ collection, filter: query?.$filter });
      return { value: records(collection, query?.$filter) };
    },
    async getRecord(_collection: string, id: string) {
      return { Id: id };
    },
    async createRecord(collection: string, data: Record<string, unknown>, options?: { id?: string }) {
      stub.created.push({ collection, data });
      return { ...data, Id: options?.id ?? CREATED };
    },
    async createRecordWithOutcome(
      collection: string,
      data: Record<string, unknown>,
      options?: { id?: string }
    ) {
      return { record: await this.createRecord(collection, data, options), created: true };
    },
    async updateRecord(collection: string, id: string, data: Record<string, unknown>) {
      stub.updated.push({ collection, id, data });
    },
  };
  const config = {
    bpmsoft_url: 'https://crm.example.test',
    username: 'tester',
    odata_version: 4,
  } as ServiceContainer['config'];
  const currentUser = {
    async get() {
      return {
        userId: CURRENT_USER,
        userName: 'Test user',
        contactId: CURRENT_CONTACT,
        timeZoneId: 'Europe/Moscow',
      };
    },
  } as unknown as ServiceContainer['currentUser'];
  // Use the real field preparation path; only the lookup search API is stubbed.
  const lookupResolver = new LookupResolver(
    config,
    odataClient as unknown as ServiceContainer['odataClient'],
    metadataManager as unknown as ServiceContainer['metadataManager'],
    { currentUser }
  );
  lookupResolver.resolve = async (collection: string, value: string) =>
    lookups[`${collection}:${value}`] ?? notFound(value);
  stub.services = {
    config,
    httpClient: null!,
    authManager: { async ensureAuthenticated() {} } as unknown as ServiceContainer['authManager'],
    odataClient: odataClient as unknown as ServiceContainer['odataClient'],
    metadataManager: metadataManager as unknown as ServiceContainer['metadataManager'],
    lookupResolver: lookupResolver as unknown as ServiceContainer['lookupResolver'],
    processEngine: null!,
    currentUser,
    initialized: true,
  };
  return stub;
}

function handler(register: (server: never, services: ServiceContainer) => void, stub: Stub): Handler {
  let captured: Handler | undefined;
  const server = {
    registerTool(_name: string, _meta: unknown, h: Handler) {
      captured = h;
    },
  };
  register(server as never, stub.services);
  return captured!;
}

describe('bpm_set_status', () => {
  const ACT = '11111111-2222-3333-4444-555555555555';

  it('prefers canonical StatusId over EmailSendStatusId', async () => {
    const stub = buildStub({ 'ActivityStatus:Завершена': found(STATUS_DONE, 'Завершена') });
    const res = await handler(
      registerSetStatusTool,
      stub
    )({ collection: 'Activity', id: ACT, status: 'Завершена' });
    expect(res.isError).toBeUndefined();
    expect(stub.updated).toEqual([{ collection: 'Activity', id: ACT, data: { StatusId: STATUS_DONE } }]);
  });

  it('accepts a record name instead of UUID', async () => {
    const stub = buildStub({
      'Activity:Звонок Иванову': found(ACT, 'Звонок Иванову'),
      'ActivityStatus:Завершена': found(STATUS_DONE, 'Завершена'),
    });
    await handler(
      registerSetStatusTool,
      stub
    )({
      collection: 'Activity',
      id: 'Звонок Иванову',
      status: 'Завершена',
      status_field: 'StatusId',
    });
    expect(stub.updated[0].id).toBe(ACT);
  });
});

describe('bpm_register_contact', () => {
  it('stores unknown position as JobTitle instead of failing', async () => {
    const stub = buildStub({});
    const res = await handler(registerRegisterContactTool, stub)({ name: 'Иван', position: 'QA' });
    expect(res.isError).toBeUndefined();
    expect(stub.created[0].data).toEqual({ Name: 'Иван', JobTitle: 'QA' });
    expect((res.structuredContent as { warnings: string[] }).warnings[0]).toContain('JobTitle');
  });

  it('returns already_exists for a contact with the same Email and creates nothing', async () => {
    const stub = buildStub({}, (c, f) =>
      c === 'Contact' && f?.startsWith('Email eq') ? [{ Id: CONTACT_EXISTING, Name: 'Иван' }] : []
    );
    const res = await handler(registerRegisterContactTool, stub)({ name: 'Иван', email: 'i@x.ru' });
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toMatchObject({
      already_exists: true,
      contact_id: CONTACT_EXISTING,
      contact_name: 'Иван',
    });
    expect(stub.created).toHaveLength(0);
  });

  it('creates the contact anyway with force=true', async () => {
    const stub = buildStub({}, () => [{ Id: CONTACT_EXISTING, Name: 'Иван' }]);
    const res = await handler(
      registerRegisterContactTool,
      stub
    )({ name: 'Иван', email: 'i@x.ru', force: true });
    expect(res.structuredContent).toMatchObject({ contact_created: true });
    expect(stub.created).toHaveLength(1);
  });
});

describe('findOrCreate (fuzzy)', () => {
  it('reuses a fuzzy match instead of creating a duplicate', async () => {
    const stub = buildStub({
      'Account:Ромашка': { ...found(ACCOUNT_EXISTING, 'ООО «Ромашка»'), matchedValue: 'ООО «Ромашка»' },
    });
    const res = await findOrCreate(
      stub.services,
      'Account',
      { field: 'Name', value: 'Ромашка' },
      { Name: 'Ромашка' }
    );
    expect(res).toMatchObject({ id: ACCOUNT_EXISTING, created: false });
    expect(stub.created).toHaveLength(0);
  });

  it('throws LookupResolutionError on several candidates and creates nothing', async () => {
    const stub = buildStub({
      'Account:Ромашка': {
        resolved: false,
        searchValue: 'Ромашка',
        matchCount: 2,
        candidates: [
          { id: ACCOUNT_EXISTING, displayValue: 'ООО «Ромашка»' },
          { id: CREATED, displayValue: 'АО «Ромашка»' },
        ],
      },
    });
    await expect(
      findOrCreate(stub.services, 'Account', { field: 'Name', value: 'Ромашка' }, { Name: 'Ромашка' })
    ).rejects.toBeInstanceOf(LookupResolutionError);
    expect(stub.created).toHaveLength(0);
  });
});

describe('bpm_log_activity', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-07T09:00:00+03:00'));
  });
  afterEach(() => vi.useRealTimers());

  it('picks the same-named category whose ActivityTypeId matches the default type', async () => {
    const stub = buildStub(
      {
        'ActivityCategory:Звонок': {
          resolved: false,
          searchValue: 'Звонок',
          matchCount: 2,
          candidates: [
            { id: CALL_CATEGORY_CALL, displayValue: 'Звонок' },
            { id: CALL_CATEGORY_TASK, displayValue: 'Звонок' },
          ],
        },
      },
      (c, filter) =>
        c === 'ActivityCategory'
          ? [
              { Id: CALL_CATEGORY_CALL, ActivityTypeId: 'e1831dec-cfc0-df11-b00f-001d60e938c6' },
              { Id: CALL_CATEGORY_TASK, ActivityTypeId: 'fbe0acdc-cfc0-df11-b00f-001d60e938c6' },
            ].filter((row) => !filter || filter.includes(row.Id))
          : []
    );
    const res = await handler(registerLogActivityTool, stub)({ title: 'Позвонить', type: 'Звонок' });
    expect(res.isError).toBeUndefined();
    expect(stub.created[0].data.ActivityCategoryId).toBe(CALL_CATEGORY_TASK);
  });

  it('maps owner_name "я" to the current contact and related_id name to a record id', async () => {
    const stub = buildStub({ 'Account:Ромашка': found(ACCOUNT_EXISTING, 'ООО «Ромашка»') });
    await handler(
      registerLogActivityTool,
      stub
    )({
      title: 'Встреча',
      owner_name: 'я',
      related_collection: 'Account',
      related_id: 'Ромашка',
    });
    expect(stub.created[0].data).toMatchObject({ OwnerId: CURRENT_CONTACT, AccountId: ACCOUNT_EXISTING });
  });

  it('uses a related OwnerId as the slot owner before checking availability', async () => {
    const stub = buildStub({});
    const res = await handler(
      registerLogActivityTool,
      stub
    )({
      title: 'Call',
      related_collection: 'Contact',
      related_id: CONTACT_EXISTING,
      related_field: 'OwnerId',
    });
    expect(res.isError).toBeUndefined();
    expect(stub.created[0].data.OwnerId).toBe(CONTACT_EXISTING);
    expect(stub.queries.find((query) => query.collection === 'Activity')?.filter).toContain(CONTACT_EXISTING);
  });
});
