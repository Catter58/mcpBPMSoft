/**
 * Unit tests for workflow tools.
 *
 * Mocks ServiceContainer dependencies (metadataManager, lookupResolver,
 * odataClient, authManager) using lightweight stubs.
 */

import { describe, it, expect } from 'vitest';
import { findOrCreate } from '../../src/workflows/find-or-create.js';
import type { ServiceContainer } from '../../src/tools/init-tool.js';
import type { EntityMetadata, EntityProperty } from '../../src/types/index.js';
import { BpmApiError } from '../../src/utils/errors.js';

interface CreatedRecord {
  collection: string;
  data: Record<string, unknown>;
}

interface UpdatedRecord {
  collection: string;
  id: string;
  data: Record<string, unknown>;
}

function buildContactMeta(): EntityMetadata {
  const properties: EntityProperty[] = [
    { name: 'Id', type: 'Edm.Guid', nullable: false, isLookup: false },
    { name: 'Name', type: 'Edm.String', nullable: false, isLookup: false },
    { name: 'Email', type: 'Edm.String', nullable: true, isLookup: false },
    { name: 'Phone', type: 'Edm.String', nullable: true, isLookup: false },
    { name: 'Job', type: 'Edm.String', nullable: true, isLookup: false },
    {
      name: 'AccountId',
      type: 'Edm.Guid',
      nullable: true,
      isLookup: true,
      lookupCollection: 'Account',
      lookupDisplayColumn: 'Name',
    },
  ];
  return { name: 'Contact', collectionName: 'Contact', properties, lookupFields: ['AccountId'], cachedAt: Date.now() };
}

function buildAccountMeta(): EntityMetadata {
  const properties: EntityProperty[] = [
    { name: 'Id', type: 'Edm.Guid', nullable: false, isLookup: false },
    { name: 'Name', type: 'Edm.String', nullable: false, isLookup: false },
  ];
  return { name: 'Account', collectionName: 'Account', properties, lookupFields: [], cachedAt: Date.now() };
}

function buildActivityMeta(): EntityMetadata {
  const properties: EntityProperty[] = [
    { name: 'Id', type: 'Edm.Guid', nullable: false, isLookup: false },
    { name: 'Title', type: 'Edm.String', nullable: false, isLookup: false },
    {
      name: 'OwnerId',
      type: 'Edm.Guid',
      nullable: true,
      isLookup: true,
      lookupCollection: 'Contact',
      lookupDisplayColumn: 'Name',
    },
    {
      name: 'ActivityCategoryId',
      type: 'Edm.Guid',
      nullable: true,
      isLookup: true,
      lookupCollection: 'ActivityCategory',
      lookupDisplayColumn: 'Name',
    },
    { name: 'DueDate', type: 'Edm.DateTimeOffset', nullable: true, isLookup: false },
    {
      name: 'AccountId',
      type: 'Edm.Guid',
      nullable: true,
      isLookup: true,
      lookupCollection: 'Account',
      lookupDisplayColumn: 'Name',
    },
  ];
  return {
    name: 'Activity',
    collectionName: 'Activity',
    properties,
    lookupFields: ['OwnerId', 'ActivityCategoryId', 'AccountId'],
    cachedAt: Date.now(),
  };
}

function buildOpportunityMeta(): EntityMetadata {
  const properties: EntityProperty[] = [
    { name: 'Id', type: 'Edm.Guid', nullable: false, isLookup: false },
    { name: 'Name', type: 'Edm.String', nullable: false, isLookup: false },
    {
      name: 'StageId',
      type: 'Edm.Guid',
      nullable: true,
      isLookup: true,
      lookupCollection: 'OpportunityStage',
      lookupDisplayColumn: 'Name',
    },
  ];
  return { name: 'Opportunity', collectionName: 'Opportunity', properties, lookupFields: ['StageId'], cachedAt: Date.now() };
}

interface StubState {
  created: CreatedRecord[];
  updated: UpdatedRecord[];
  recordsByCollection: Record<string, Array<Record<string, unknown>>>;
  metaByCollection: Record<string, EntityMetadata>;
  resolveCalls: Array<{ collection: string; value: string; column: string }>;
  resolveResponses: Record<string, { id: string }>;
}

function buildStubServices(state: StubState): ServiceContainer {
  const metadataManager = {
    async resolveCollectionReference(query: string) {
      if (state.metaByCollection[query]) return { name: query };
      return { name: null, suggestions: Object.keys(state.metaByCollection) };
    },
    async resolveFieldReference(collection: string, query: string) {
      const meta = state.metaByCollection[collection];
      if (!meta) return { name: null, suggestions: [] };
      const direct = meta.properties.find((p) => p.name === query);
      if (direct) return { name: direct.name };
      return { name: null, suggestions: meta.properties.map((p) => p.name) };
    },
    async getEntityMetadata(collection: string) {
      const meta = state.metaByCollection[collection];
      if (!meta) throw new Error(`Unknown collection ${collection}`);
      return meta;
    },
    async getLookupInfo(collection: string, fieldName: string) {
      const meta = state.metaByCollection[collection];
      if (!meta) return null;
      const prop = meta.properties.find((p) => p.name === fieldName);
      if (!prop?.isLookup || !prop.lookupCollection) return null;
      return {
        lookupCollection: prop.lookupCollection,
        displayColumn: prop.lookupDisplayColumn ?? 'Name',
      };
    },
    async getEntitySets() {
      return Object.keys(state.metaByCollection).map((name) => ({ name, entityType: name }));
    },
  };

  const odataClient = {
    async getRecords<T>(collection: string, query?: { $filter?: string; $top?: number; $select?: string }) {
      const records = state.recordsByCollection[collection] ?? [];
      let filtered = records;
      if (query?.$filter) {
        const eqMatch = /^(\w+)\s+eq\s+'(.+)'$/.exec(query.$filter);
        if (eqMatch) {
          const [, field, rawValue] = eqMatch;
          const value = rawValue.replace(/''/g, "'");
          filtered = records.filter((r) => String(r[field] ?? '') === value);
        }
        const containsMatch = /^contains\((\w+),'(.+)'\)$/.exec(query.$filter);
        if (containsMatch) {
          const [, field, rawValue] = containsMatch;
          const value = rawValue.replace(/''/g, "'");
          filtered = records.filter((r) => String(r[field] ?? '').includes(value));
        }
      }
      if (query?.$top) filtered = filtered.slice(0, query.$top);
      return { value: filtered as T[] };
    },
    async createRecord<T>(collection: string, data: Record<string, unknown>): Promise<T> {
      const id = `created-${collection}-${state.created.length + 1}`;
      const record = { Id: id, ...data };
      state.created.push({ collection, data });
      const list = state.recordsByCollection[collection] ?? (state.recordsByCollection[collection] = []);
      list.push(record);
      return record as T;
    },
    async updateRecord(collection: string, id: string, data: Record<string, unknown>): Promise<void> {
      state.updated.push({ collection, id, data });
    },
  };

  const lookupResolver = {
    async resolve(lookupCollection: string, value: string, column = 'Name') {
      state.resolveCalls.push({ collection: lookupCollection, value, column });
      const key = `${lookupCollection}:${column}:${value}`;
      const hit = state.resolveResponses[key];
      if (hit) {
        return { resolved: true, id: hit.id, searchValue: value, matchCount: 1, candidates: [{ id: hit.id, displayValue: value }] };
      }
      return { resolved: false, searchValue: value, matchCount: 0, candidates: [] };
    },
    async resolveDataLookups(_collection: string, data: Record<string, unknown>) {
      return { ...data };
    },
  };

  const authManager = {
    async ensureAuthenticated() {
      // no-op
    },
  };

  return {
    config: null!,
    httpClient: null!,
    authManager: authManager as unknown as ServiceContainer['authManager'],
    odataClient: odataClient as unknown as ServiceContainer['odataClient'],
    metadataManager: metadataManager as unknown as ServiceContainer['metadataManager'],
    lookupResolver: lookupResolver as unknown as ServiceContainer['lookupResolver'],
    processEngine: null! as ServiceContainer['processEngine'],
    initialized: true,
  };
}

function emptyState(): StubState {
  return {
    created: [],
    updated: [],
    recordsByCollection: {},
    metaByCollection: {
      Contact: buildContactMeta(),
      Account: buildAccountMeta(),
      Activity: buildActivityMeta(),
      Opportunity: buildOpportunityMeta(),
    },
    resolveCalls: [],
    resolveResponses: {},
  };
}

describe('findOrCreate', () => {
  it('creates a new record when nothing matches', async () => {
    const state = emptyState();
    state.recordsByCollection.Account = [];
    const services = buildStubServices(state);

    const result = await findOrCreate(
      services,
      'Account',
      { field: 'Name', value: 'Ромашка' },
      { Name: 'Ромашка' }
    );

    expect(result.created).toBe(true);
    expect(result.id).toMatch(/^created-Account-/);
    expect(state.created).toHaveLength(1);
    expect(state.created[0].data).toEqual({ Name: 'Ромашка' });
  });

  it('returns the existing record when there is exactly one match', async () => {
    const state = emptyState();
    state.recordsByCollection.Account = [{ Id: 'acc-1', Name: 'Ромашка' }];
    const services = buildStubServices(state);

    const result = await findOrCreate(
      services,
      'Account',
      { field: 'Name', value: 'Ромашка' },
      { Name: 'Ромашка' }
    );

    expect(result.created).toBe(false);
    expect(result.id).toBe('acc-1');
    expect(state.created).toHaveLength(0);
  });

  it('throws BpmApiError(400) on multiple matches', async () => {
    const state = emptyState();
    state.recordsByCollection.Account = [
      { Id: 'acc-1', Name: 'Ромашка' },
      { Id: 'acc-2', Name: 'Ромашка' },
    ];
    const services = buildStubServices(state);

    await expect(
      findOrCreate(services, 'Account', { field: 'Name', value: 'Ромашка' }, { Name: 'Ромашка' })
    ).rejects.toBeInstanceOf(BpmApiError);
  });

  it('escapes single quotes inside the search value', async () => {
    const state = emptyState();
    state.recordsByCollection.Account = [{ Id: 'acc-1', Name: "O'Brien Co." }];
    const services = buildStubServices(state);

    const result = await findOrCreate(
      services,
      'Account',
      { field: 'Name', value: "O'Brien Co." },
      { Name: "O'Brien Co." }
    );

    expect(result.created).toBe(false);
    expect(result.id).toBe('acc-1');
  });
});

describe('register-contact workflow logic', () => {
  it('creates Account and Contact with auto-detected AccountId link', async () => {
    const state = emptyState();
    state.recordsByCollection.Account = [];
    state.recordsByCollection.Contact = [];
    const services = buildStubServices(state);

    // Inline-equivalent of the tool body — exercises findOrCreate + lookup discovery
    const accountResult = await findOrCreate(
      services,
      'Account',
      { field: 'Name', value: 'Ромашка' },
      { Name: 'Ромашка' }
    );

    const contactMeta = await services.metadataManager.getEntityMetadata('Contact');
    const accountLookup = contactMeta.properties.find(
      (p) => p.isLookup && p.lookupCollection === 'Account'
    );
    expect(accountLookup?.name).toBe('AccountId');

    const data: Record<string, unknown> = { Name: 'Иванов И.И.' };
    if (accountLookup) data[accountLookup.name] = accountResult.id;

    const created = await services.odataClient.createRecord<Record<string, unknown>>('Contact', data);
    const createdRecord = created as { Id: string; AccountId?: string };

    expect(createdRecord.AccountId).toBe(accountResult.id);
    expect(state.created.find((c) => c.collection === 'Account')).toBeDefined();
    expect(state.created.find((c) => c.collection === 'Contact')).toBeDefined();
  });
});

describe('log-activity workflow logic', () => {
  it('resolves owner_name to OwnerId via Contact lookup and uses ActivityCategoryId for type', async () => {
    const state = emptyState();
    state.recordsByCollection.Activity = [];
    state.resolveResponses['Contact:Name:Иванов'] = { id: 'contact-42' };
    const services = buildStubServices(state);

    const activityMeta = await services.metadataManager.getEntityMetadata('Activity');
    const ownerField = activityMeta.properties.find((p) => p.name === 'OwnerId');
    const typeField = activityMeta.properties.find((p) => p.name === 'ActivityCategoryId');
    expect(ownerField?.isLookup).toBe(true);
    expect(typeField?.isLookup).toBe(true);

    const ownerLookup = await services.lookupResolver.resolve(
      ownerField!.lookupCollection!,
      'Иванов',
      ownerField!.lookupDisplayColumn ?? 'Name'
    );
    expect(ownerLookup.resolved).toBe(true);
    expect(ownerLookup.id).toBe('contact-42');

    const data: Record<string, unknown> = {
      Title: 'Звонок клиенту',
      [ownerField!.name]: ownerLookup.id,
      [typeField!.name]: 'Звонок',
    };
    await services.odataClient.createRecord('Activity', data);

    const activityCreate = state.created.find((c) => c.collection === 'Activity');
    expect(activityCreate?.data).toMatchObject({
      Title: 'Звонок клиенту',
      OwnerId: 'contact-42',
      ActivityCategoryId: 'Звонок',
    });
    expect(state.resolveCalls.find((c) => c.collection === 'Contact' && c.value === 'Иванов')).toBeDefined();
  });
});

describe('set-status workflow logic', () => {
  it('finds StageId field and updates the record with resolved lookup id', async () => {
    const state = emptyState();
    state.recordsByCollection.Opportunity = [{ Id: 'opp-1', Name: 'Сделка', StageId: null }];
    state.resolveResponses['OpportunityStage:Name:Won'] = { id: 'stage-won' };
    const services = buildStubServices(state);

    const meta = await services.metadataManager.getEntityMetadata('Opportunity');
    const candidates = meta.properties.filter(
      (p) => p.isLookup && (p.name.toLowerCase().includes('status') || p.name.toLowerCase().includes('stage'))
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].name).toBe('StageId');

    const lookupInfo = await services.metadataManager.getLookupInfo('Opportunity', candidates[0].name);
    expect(lookupInfo?.lookupCollection).toBe('OpportunityStage');

    const lookupResult = await services.lookupResolver.resolve(
      lookupInfo!.lookupCollection,
      'Won',
      lookupInfo!.displayColumn
    );
    expect(lookupResult.resolved).toBe(true);

    await services.odataClient.updateRecord('Opportunity', 'opp-1', {
      [candidates[0].name]: lookupResult.id,
    });

    expect(state.updated).toEqual([
      { collection: 'Opportunity', id: 'opp-1', data: { StageId: 'stage-won' } },
    ]);
  });
});
