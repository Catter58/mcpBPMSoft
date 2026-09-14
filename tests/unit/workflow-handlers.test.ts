/**
 * Unit tests for workflow tool handlers (bpm_set_status, bpm_register_contact,
 * bpm_log_activity). Tools are registered on a FakeServer that captures the
 * handler closure; services are lightweight stubs.
 */

import { describe, it, expect } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerSetStatusTool } from '../../src/workflows/set-status.js';
import { registerRegisterContactTool } from '../../src/workflows/register-contact.js';
import { registerLogActivityTool } from '../../src/workflows/log-activity.js';
import { findOrCreate } from '../../src/workflows/find-or-create.js';
import type { ServiceContainer } from '../../src/tools/init-tool.js';
import type { EntityMetadata, EntityProperty, LookupResult } from '../../src/types/index.js';
import { LookupResolutionError } from '../../src/utils/errors.js';

type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;

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
    str('Name'),
    str('Email'),
    str('JobTitle'),
    lookup('JobId', 'Job'),
    lookup('AccountId', 'Account'),
  ]),
  Account: meta('Account', [str('Name')]),
  Activity: meta('Activity', [
    str('Title'),
    lookup('OwnerId', 'Contact'),
    lookup('ActivityCategoryId', 'ActivityCategory'),
    lookup('AccountId', 'Account'),
    lookup('StatusId', 'ActivityStatus'),
    lookup('EmailSendStatusId', 'EmailSendStatus'),
  ]),
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
  const lookupResolver = {
    async resolve(collection: string, value: string) {
      return lookups[`${collection}:${value}`] ?? notFound(value);
    },
    async resolveDataLookups(_c: string, data: Record<string, unknown>) {
      return { data: { ...data }, notes: [] };
    },
  };
  const odataClient = {
    async getRecords(collection: string, query?: { $filter?: string }) {
      stub.queries.push({ collection, filter: query?.$filter });
      return { value: records(collection, query?.$filter) };
    },
    async createRecord(collection: string, data: Record<string, unknown>) {
      stub.created.push({ collection, data });
      return { Id: `new-${collection}`, ...data };
    },
    async updateRecord(collection: string, id: string, data: Record<string, unknown>) {
      stub.updated.push({ collection, id, data });
    },
  };
  stub.services = {
    config: { odata_version: 4 } as ServiceContainer['config'],
    httpClient: null!,
    authManager: { async ensureAuthenticated() {} } as unknown as ServiceContainer['authManager'],
    odataClient: odataClient as unknown as ServiceContainer['odataClient'],
    metadataManager: metadataManager as unknown as ServiceContainer['metadataManager'],
    lookupResolver: lookupResolver as unknown as ServiceContainer['lookupResolver'],
    processEngine: null!,
    currentUser: {
      async get() {
        return { userId: 'user-1', userName: 'Supervisor', contactId: 'me-contact' };
      },
    } as unknown as ServiceContainer['currentUser'],
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
    const stub = buildStub({ 'ActivityStatus:Завершена': found('st-done', 'Завершена') });
    const res = await handler(
      registerSetStatusTool,
      stub
    )({ collection: 'Activity', id: ACT, status: 'Завершена' });
    expect(res.isError).toBeUndefined();
    expect(stub.updated).toEqual([{ collection: 'Activity', id: ACT, data: { StatusId: 'st-done' } }]);
  });

  it('accepts a record name instead of UUID', async () => {
    const stub = buildStub({
      'Activity:Звонок Иванову': found(ACT, 'Звонок Иванову'),
      'ActivityStatus:Завершена': found('st-done', 'Завершена'),
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
      c === 'Contact' && f?.startsWith('Email eq') ? [{ Id: 'c-1', Name: 'Иван' }] : []
    );
    const res = await handler(registerRegisterContactTool, stub)({ name: 'Иван', email: 'i@x.ru' });
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toMatchObject({
      already_exists: true,
      contact_id: 'c-1',
      contact_name: 'Иван',
    });
    expect(stub.created).toHaveLength(0);
  });

  it('creates the contact anyway with force=true', async () => {
    const stub = buildStub({}, () => [{ Id: 'c-1', Name: 'Иван' }]);
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
      'Account:Ромашка': { ...found('acc-1', 'ООО «Ромашка»'), matchedValue: 'ООО «Ромашка»' },
    });
    const res = await findOrCreate(
      stub.services,
      'Account',
      { field: 'Name', value: 'Ромашка' },
      { Name: 'Ромашка' }
    );
    expect(res).toMatchObject({ id: 'acc-1', created: false });
    expect(stub.created).toHaveLength(0);
  });

  it('throws LookupResolutionError on several candidates and creates nothing', async () => {
    const stub = buildStub({
      'Account:Ромашка': {
        resolved: false,
        searchValue: 'Ромашка',
        matchCount: 2,
        candidates: [
          { id: 'a1', displayValue: 'ООО «Ромашка»' },
          { id: 'a2', displayValue: 'АО «Ромашка»' },
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
      (c) =>
        c === 'ActivityCategory'
          ? [
              { Id: CALL_CATEGORY_CALL, ActivityTypeId: 'e1831dec-cfc0-df11-b00f-001d60e938c6' },
              { Id: CALL_CATEGORY_TASK, ActivityTypeId: 'fbe0acdc-cfc0-df11-b00f-001d60e938c6' },
            ]
          : []
    );
    const res = await handler(registerLogActivityTool, stub)({ title: 'Позвонить', type: 'Звонок' });
    expect(res.isError).toBeUndefined();
    expect(stub.created[0].data.ActivityCategoryId).toBe(CALL_CATEGORY_TASK);
  });

  it('maps owner_name "я" to the current contact and related_id name to a record id', async () => {
    const stub = buildStub({ 'Account:Ромашка': found('acc-1', 'ООО «Ромашка»') });
    await handler(
      registerLogActivityTool,
      stub
    )({
      title: 'Встреча',
      owner_name: 'я',
      related_collection: 'Account',
      related_id: 'Ромашка',
    });
    expect(stub.created[0].data).toMatchObject({ OwnerId: 'me-contact', AccountId: 'acc-1' });
  });
});
