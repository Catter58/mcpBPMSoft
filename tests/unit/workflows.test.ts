/** Exercise registered workflow handlers, including validation and partial writes. */
import { describe, expect, it, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceContainer } from '../../src/tools/init-tool.js';
import type { EntityMetadata, EntityProperty } from '../../src/types/index.js';
import { BpmApiError, LookupResolutionError } from '../../src/utils/errors.js';
import { findOrCreate } from '../../src/workflows/find-or-create.js';
import { registerRegisterContactTool } from '../../src/workflows/register-contact.js';
import { registerLogActivityTool } from '../../src/workflows/log-activity.js';
import { registerSetStatusTool } from '../../src/workflows/set-status.js';
import { ODataClient } from '../../src/client/odata-client.js';
import { buildConfig } from '../../src/config.js';
import { MockHttpClient } from '../setup/mock-http-client.js';

const A = 'aaaaaaaa-1111-4111-8111-111111111111';
const B = 'bbbbbbbb-2222-4222-8222-222222222222';
function property(name: string, type = 'Edm.String', lookupCollection?: string): EntityProperty {
  return {
    name,
    type,
    nullable: true,
    isLookup: !!lookupCollection,
    ...(lookupCollection ? { lookupCollection, lookupDisplayColumn: 'Name' } : {}),
  };
}
function metadata(name: string, properties: EntityProperty[]): EntityMetadata {
  return {
    name,
    collectionName: name,
    properties: [property('Id', 'Edm.Guid'), ...properties],
    lookupFields: properties.filter((p) => p.isLookup).map((p) => p.name),
    cachedAt: Date.now(),
  };
}
function setup() {
  const metas: Record<string, EntityMetadata> = {
    Account: metadata('Account', [property('Name')]),
    Contact: metadata('Contact', [
      property('Name'),
      property('Email'),
      property('Phone'),
      property('Job'),
      property('AccountId', 'Edm.Guid', 'Account'),
    ]),
    Activity: metadata('Activity', [
      property('Title'),
      property('Notes'),
      property('DueDate', 'Edm.DateTimeOffset'),
      property('OwnerId', 'Edm.Guid', 'Contact'),
      property('TypeId', 'Edm.Guid', 'ActivityType'),
      property('AccountId', 'Edm.Guid', 'Account'),
    ]),
    Opportunity: metadata('Opportunity', [property('StatusId', 'Edm.Guid', 'OpportunityStatus')]),
  };
  const createRecord = vi.fn(
    async (_collection: string, data: Record<string, unknown>, options?: { id?: string }) => ({
      ...data,
      Id: options?.id ?? A,
    })
  );
  const odataClient = {
    getRecords: vi.fn(async () => ({ value: [] as Record<string, unknown>[] })),
    getRecord: vi.fn(async (_collection: string, id: string) => ({ Id: id, Name: 'Existing' })),
    createRecord,
    createRecordWithOutcome: vi.fn(
      async (collection: string, data: Record<string, unknown>, options?: { id?: string }) => ({
        record: await createRecord(collection, data, options),
        created: true as boolean | null,
      })
    ),
    updateRecord: vi.fn(async () => undefined),
  };
  const lookupResolver = {
    resolve: vi.fn(async () => ({ resolved: false, matchCount: 0, candidates: [] })),
    resolveDataLookups: vi.fn(async (collection: string, data: Record<string, unknown>) => {
      for (const key of Object.keys(data))
        if (!metas[collection].properties.some((p) => p.name === key))
          throw new BpmApiError(`Unknown field ${key}`, 400, collection);
      return { data: { ...data }, notes: [] };
    }),
  };
  const services = {
    initialized: true,
    config: { bpmsoft_url: 'https://crm.example.test', username: 'tester', odata_version: 4 },
    authManager: { ensureAuthenticated: vi.fn(async () => undefined) },
    odataClient,
    lookupResolver,
    metadataManager: {
      getEntityMetadata: vi.fn(async (collection: string) => metas[collection]),
      resolveCollectionReference: vi.fn(async (name: string) => ({ name })),
      resolveFieldReference: vi.fn(async (_collection: string, name: string) => ({ name })),
      getLookupInfo: vi.fn(async () => ({ lookupCollection: 'OpportunityStatus', displayColumn: 'Name' })),
    },
  } as unknown as ServiceContainer;
  const handlers = new Map<string, (params: Record<string, unknown>) => Promise<CallToolResult>>();
  const server = {
    registerTool: (
      name: string,
      _config: unknown,
      handler: (params: Record<string, unknown>) => Promise<CallToolResult>
    ) => handlers.set(name, handler),
  };
  registerRegisterContactTool(server as never, services);
  registerLogActivityTool(server as never, services);
  registerSetStatusTool(server as never, services);
  return {
    services,
    metas,
    odataClient,
    lookupResolver,
    call: (name: string, params: Record<string, unknown>) => handlers.get(name)!(params),
  };
}

describe('findOrCreate', () => {
  it('creates with a client UUID when no exact match exists', async () => {
    const env = setup();
    const result = await findOrCreate(
      env.services,
      'Account',
      { field: 'Name', value: 'Example' },
      { Name: 'Example' }
    );
    expect(result.created).toBe(true);
    expect(env.odataClient.createRecord).toHaveBeenCalledWith(
      'Account',
      { Name: 'Example' },
      { id: result.id }
    );
    expect(env.odataClient.getRecords).toHaveBeenCalledWith(
      'Account',
      { $filter: "Name eq 'Example'", $top: 2 },
      true,
      2
    );
  });
  it('returns an existing exact match without creating', async () => {
    const env = setup();
    env.odataClient.getRecords.mockResolvedValue({ value: [{ Id: A, Name: 'Example' }] });
    expect(
      await findOrCreate(env.services, 'Account', { field: 'Name', value: 'Example' }, { Name: 'Example' })
    ).toMatchObject({ id: A, created: false });
    expect(env.odataClient.createRecord).not.toHaveBeenCalled();
  });
  it('rejects ambiguity and incomplete one-record pages', async () => {
    const env = setup();
    env.odataClient.getRecords.mockResolvedValue({ value: [{ Id: A }, { Id: B }] });
    await expect(
      findOrCreate(env.services, 'Account', { field: 'Name', value: 'Example' }, { Name: 'Example' })
    ).rejects.toThrow('несколько');
    env.odataClient.getRecords.mockResolvedValue({
      value: [{ Id: A }],
      '@odata.nextLink': '/odata/Account?next=1',
    } as never);
    await expect(
      findOrCreate(env.services, 'Account', { field: 'Name', value: 'Example' }, { Name: 'Example' })
    ).rejects.toThrow('несколько');
    expect(env.odataClient.createRecord).not.toHaveBeenCalled();
  });
  it('escapes apostrophes and uses metadata scalar types', async () => {
    const env = setup();
    await findOrCreate(env.services, 'Account', { field: 'Name', value: "O'Reilly" }, { Name: "O'Reilly" });
    expect(env.odataClient.getRecords.mock.calls[0][1]).toMatchObject({ $filter: "Name eq 'O''Reilly'" });
    env.metas.Account.properties.push(property('Code', 'Edm.Int32'));
    await findOrCreate(env.services, 'Account', { field: 'Code', value: '123' }, { Name: 'Code example' });
    expect(env.odataClient.getRecords.mock.calls[1][1]).toMatchObject({ $filter: 'Code eq 123' });
  });
});

describe('registered contact workflow', () => {
  it('reports a repeated deterministic contact as existing through the actual client without another POST', async () => {
    const env = setup();
    const http = new MockHttpClient();
    const config = buildConfig('https://crm.example.test', 'tester', 'example-password', {
      odata_version: 4,
      platform: 'net8',
    });
    let stored: Record<string, unknown> | undefined;
    http.setFallback((request) => {
      if (new URL(request.url).searchParams.has('$filter')) return { data: { value: [] } };
      if (request.method === 'POST') {
        stored = request.body as Record<string, unknown>;
        return { status: 201, data: stored };
      }
      if (!stored) throw new BpmApiError('Absent', 404);
      return { data: stored };
    });
    env.services.odataClient = new ODataClient(config, http as never);
    const args = { name: 'Ivan', idempotency_key: 'repeat-contact' };
    const first = await env.call('bpm_register_contact', args);
    const second = await env.call('bpm_register_contact', args);
    expect(first.isError).toBeUndefined();
    expect(first.structuredContent?.contact_created).toBe(true);
    expect(second.isError).toBeUndefined();
    expect(second.structuredContent?.contact_created).toBe(false);
    expect(second.structuredContent?.contact_id).toBe(first.structuredContent?.contact_id);
    expect(second.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining('использован существующий') }),
    ]);
    expect(
      http.requests
        .filter((request) => !new URL(request.url).searchParams.has('$filter'))
        .map((request) => request.method)
    ).toEqual(['GET', 'POST', 'GET']);
  });
  it('propagates uncertain reconciliation as null while confirming both records and explaining it', async () => {
    const env = setup();
    env.odataClient.createRecordWithOutcome.mockImplementation(async (_collection, data, options) => ({
      record: { ...data, Id: options?.id ?? A },
      created: null,
    }));
    const result = await env.call('bpm_register_contact', {
      name: 'Ivan',
      account_name: 'Example',
      idempotency_key: 'uncertain-registration',
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      account_created: null,
      contact_created: null,
      outcomes: [
        expect.objectContaining({ step: 'account', state: 'succeeded' }),
        expect.objectContaining({ step: 'contact', state: 'succeeded' }),
      ],
    });
    expect(result.structuredContent?.warnings).toHaveLength(2);
    expect(result.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining('факт создания неизвестен') }),
    ]);
  });
  it('reports null for an unknown contact creation failure and false when the request is rejected', async () => {
    for (const uncertain of [false, true]) {
      const env = setup();
      env.odataClient.createRecordWithOutcome.mockRejectedValue(
        new BpmApiError(
          'Write response',
          uncertain ? 503 : 400,
          'Contact',
          undefined,
          undefined,
          undefined,
          uncertain ? 'outcome_unknown' : undefined
        )
      );
      const result = await env.call('bpm_register_contact', {
        name: 'Ivan',
        idempotency_key: 'failed-registration',
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent?.contact_created).toBe(uncertain ? null : false);
      expect(result.structuredContent?.outcomes).toEqual([
        expect.objectContaining({ step: 'contact', state: uncertain ? 'outcome_unknown' : 'failed' }),
      ]);
    }
  });
  it('keeps contact creation false when an account creation has an unknown outcome', async () => {
    const env = setup();
    env.odataClient.createRecordWithOutcome.mockRejectedValue(
      new BpmApiError('Lost answer', 503, 'Account', undefined, undefined, undefined, 'outcome_unknown')
    );
    const result = await env.call('bpm_register_contact', {
      name: 'Ivan',
      account_name: 'Example',
      idempotency_key: 'uncertain-account',
    });
    expect(result.structuredContent).toMatchObject({
      account_created: null,
      contact_created: false,
      outcomes: [
        expect.objectContaining({ step: 'account', state: 'outcome_unknown' }),
        expect.objectContaining({ step: 'contact', state: 'not_executed' }),
      ],
    });
  });
  it('preflights contact before creating account, then creates both with the relation', async () => {
    const env = setup();
    const result = await env.call('bpm_register_contact', { name: 'Ivan', account_name: 'Example' });
    expect(result.isError).toBeUndefined();
    const account = env.odataClient.createRecord.mock.calls[0];
    const contact = env.odataClient.createRecord.mock.calls[1];
    expect(account[0]).toBe('Account');
    expect(contact[0]).toBe('Contact');
    expect(contact[1]).toMatchObject({ AccountId: account[2]!.id });
    expect(result.structuredContent).toMatchObject({ contact_created: true, account_created: true });
  });
  it('does not create an account when contact validation fails', async () => {
    const env = setup();
    const result = await env.call('bpm_register_contact', {
      name: 'Ivan',
      account_name: 'Example',
      extra: { TypoField: 'bad' },
    });
    expect(result.isError).toBe(true);
    expect(env.odataClient.createRecord).not.toHaveBeenCalled();
    expect(result.structuredContent?.outcomes).toEqual([
      expect.objectContaining({ step: 'account', state: 'not_executed' }),
      expect.objectContaining({ step: 'contact', state: 'not_executed' }),
    ]);
  });
  it('requires a unique Account relation before any write', async () => {
    const env = setup();
    env.metas.Contact.properties = env.metas.Contact.properties.filter((p) => p.name !== 'AccountId');
    const result = await env.call('bpm_register_contact', { name: 'Ivan', account_name: 'Example' });
    expect(result.isError).toBe(true);
    expect(env.odataClient.createRecord).not.toHaveBeenCalled();
  });
  it('reports the committed account UUID when contact creation fails', async () => {
    const env = setup();
    env.odataClient.createRecord.mockImplementation(async (collection, data, options) => {
      if (collection === 'Contact') throw new BpmApiError('Rejected by business rule', 400, 'Contact');
      return { ...data, Id: options!.id! };
    });
    const result = await env.call('bpm_register_contact', {
      name: 'Ivan',
      account_name: 'Example',
      idempotency_key: 'registration-one',
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      account_created: true,
      contact_created: false,
      account_id: expect.any(String),
      contact_id: expect.any(String),
      outcomes: [
        expect.objectContaining({ step: 'account', state: 'succeeded' }),
        expect.objectContaining({ step: 'contact', state: 'failed' }),
      ],
    });
  });
  it('resumes with an explicit existing account and stable contact ID', async () => {
    const env = setup();
    const args = { name: 'Ivan', account_id: A, idempotency_key: 'registration-one' };
    const first = await env.call('bpm_register_contact', args);
    const second = await env.call('bpm_register_contact', args);
    expect(first.structuredContent?.contact_id).toBe(second.structuredContent?.contact_id);
    expect(env.odataClient.createRecord.mock.calls.every((call) => call[0] === 'Contact')).toBe(true);
    expect(env.odataClient.getRecord).toHaveBeenCalledWith('Account', A);
  });
  it('rejects contradicting explicit and extra fields before writes', async () => {
    const env = setup();
    const result = await env.call('bpm_register_contact', { name: 'Ivan', extra: { Name: 'Someone else' } });
    expect(result.isError).toBe(true);
    expect(env.odataClient.createRecord).not.toHaveBeenCalled();
  });
});

describe('registered activity workflow', () => {
  it('selects the primary Contact relation among owner, author and custom Contact fields', async () => {
    const env = setup();
    env.metas.Activity.properties.push(
      ...['AuthorId', 'CreatedById', 'ModifiedById', 'ContactId', 'ApproverId', 'AlternateContactId'].map(
        (name) => property(name, 'Edm.Guid', 'Contact')
      )
    );
    const result = await env.call('bpm_log_activity', {
      title: 'Call',
      owner_name: 'Ivan',
      related_collection: 'Contact',
      related_id: A,
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.used_fields).toMatchObject({ owner: 'OwnerId', relation: 'ContactId' });
    expect(env.odataClient.createRecord.mock.calls[0][1]).toMatchObject({ OwnerId: 'Ivan', ContactId: A });
  });
  it.each(['legacy', 'navigation'] as const)('selects the canonical %s Contact relation', async (mode) => {
    const env = setup();
    const relation = property(mode === 'legacy' ? 'Contact' : 'UsrPrimaryContactId', 'Edm.Guid', 'Contact');
    if (mode === 'navigation') relation.navigationProperty = 'Contact';
    env.metas.Activity.properties.push(property('AuthorId', 'Edm.Guid', 'Contact'), relation);
    const result = await env.call('bpm_log_activity', {
      title: 'Call',
      related_collection: 'Contact',
      related_id: A,
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.used_fields).toMatchObject({ relation: relation.name });
  });
  it('returns custom relation choices and accepts an explicit field override', async () => {
    const env = setup();
    env.metas.Activity.properties = env.metas.Activity.properties.filter(
      (field) => field.name !== 'AccountId'
    );
    env.metas.Activity.properties.push(
      property('UsrAccountId', 'Edm.Guid', 'Account'),
      property('UsrOtherAccountId', 'Edm.Guid', 'Account')
    );
    const args = { title: 'Call', related_collection: 'Account', related_id: A };
    const ambiguous = await env.call('bpm_log_activity', args);
    expect(ambiguous.structuredContent?.candidates).toEqual([
      { field: 'UsrAccountId', caption: 'UsrAccountId', lookup_collection: 'Account' },
      { field: 'UsrOtherAccountId', caption: 'UsrOtherAccountId', lookup_collection: 'Account' },
    ]);
    expect(env.odataClient.createRecord).not.toHaveBeenCalled();
    const explicit = await env.call('bpm_log_activity', { ...args, related_field: 'UsrOtherAccountId' });
    expect(explicit.isError).toBeUndefined();
    expect(env.odataClient.createRecord.mock.calls[0][1]).toMatchObject({ UsrOtherAccountId: A });
  });
  it('rejects a wrong-target explicit relation and conflicting owner instead of overwriting intent', async () => {
    const env = setup();
    const wrong = await env.call('bpm_log_activity', {
      title: 'Call',
      related_collection: 'Contact',
      related_id: A,
      related_field: 'AccountId',
    });
    expect(wrong.isError).toBe(true);
    const conflict = await env.call('bpm_log_activity', {
      title: 'Call',
      owner_name: B,
      related_collection: 'Contact',
      related_id: A,
      related_field: 'OwnerId',
    });
    expect(conflict.isError).toBe(true);
    expect(env.odataClient.createRecord).not.toHaveBeenCalled();
    expect(conflict.structuredContent?.error).toContain('разные значения');
  });
  it('passes owner and type through the same write resolution policy', async () => {
    const env = setup();
    const result = await env.call('bpm_log_activity', { title: 'Call', owner_name: 'Ivan', type: 'Call' });
    expect(result.isError).toBeUndefined();
    expect(env.lookupResolver.resolveDataLookups).toHaveBeenCalledWith('Activity', {
      Title: 'Call',
      OwnerId: 'Ivan',
      TypeId: 'Call',
    });
  });
  it('does not create when owner resolution is ambiguous', async () => {
    const env = setup();
    env.lookupResolver.resolveDataLookups.mockRejectedValue(
      new LookupResolutionError('OwnerId', 'Ivan', 2, [
        { id: A, displayValue: 'Ivan A' },
        { id: B, displayValue: 'Ivan B' },
      ])
    );
    const result = await env.call('bpm_log_activity', { title: 'Call', owner_name: 'Ivan' });
    expect(result.isError).toBe(true);
    expect(env.odataClient.createRecord).not.toHaveBeenCalled();
  });
  it.each([
    { notes: 'Details' },
    { due_date: '2026-01-01T12:00:00Z' },
    { type: 'Call' },
    { owner_name: 'Ivan' },
  ])('rejects supplied unsupported requirement %j', async (requirement) => {
    const env = setup();
    env.metas.Activity.properties = [property('Title')];
    const result = await env.call('bpm_log_activity', { title: 'Call', ...requirement });
    expect(result.isError).toBe(true);
    expect(env.odataClient.createRecord).not.toHaveBeenCalled();
  });
  it('requires both related collection and UUID, and a unique field', async () => {
    const env = setup();
    expect((await env.call('bpm_log_activity', { title: 'Call', related_id: A })).isError).toBe(true);
    env.metas.Activity.properties = env.metas.Activity.properties.filter(
      (field) => field.name !== 'AccountId'
    );
    env.metas.Activity.properties.push(
      property('AlternateAccountId', 'Edm.Guid', 'Account'),
      property('SecondAccountId', 'Edm.Guid', 'Account')
    );
    expect(
      (await env.call('bpm_log_activity', { title: 'Call', related_collection: 'Account', related_id: A }))
        .isError
    ).toBe(true);
    expect(env.odataClient.createRecord).not.toHaveBeenCalled();
  });
  it('reports a stable UUID for a mutation with unknown outcome', async () => {
    const env = setup();
    env.odataClient.createRecord.mockRejectedValue(
      new BpmApiError('Connection lost', 502, 'Activity', undefined, undefined, undefined, 'outcome_unknown')
    );
    const result = await env.call('bpm_log_activity', { title: 'Call', idempotency_key: 'one-activity' });
    expect(result.structuredContent).toMatchObject({
      activity_id: expect.any(String),
      state: 'outcome_unknown',
    });
  });
});

describe('registered status workflow', () => {
  it('uses write resolution and forwards the expected version', async () => {
    const env = setup();
    env.lookupResolver.resolveDataLookups.mockResolvedValue({ data: { StatusId: A }, notes: [] });
    const result = await env.call('bpm_set_status', {
      collection: 'Opportunity',
      id: B,
      status: 'Open',
      expected_etag: 'W/"1"',
    });
    expect(result.isError).toBeUndefined();
    expect(env.odataClient.updateRecord).toHaveBeenCalledWith(
      'Opportunity',
      B,
      { StatusId: A },
      { expectedEtag: 'W/"1"' }
    );
  });
});

describe('contact direct-handler key validation', () => {
  it('does not create an account for an invalid key or conflicting contact UUID', async () => {
    for (const extra of [{ idempotency_key: ' ' }, { idempotency_key: 'one-contact', extra: { Id: A } }]) {
      const env = setup();
      const result = await env.call('bpm_register_contact', {
        name: 'Ivan',
        account_name: 'Example',
        ...extra,
      });
      expect(result.isError).toBe(true);
      expect(env.odataClient.createRecord).not.toHaveBeenCalled();
    }
  });
});

describe('find-or-create concurrent intent identity', () => {
  it.each([false, null])(
    'preserves client creation outcome %s when the planned UUID is reconciled',
    async (created) => {
      const env = setup();
      env.odataClient.createRecordWithOutcome.mockImplementation(async (_collection, data, options) => ({
        record: { ...data, Id: options?.id ?? A },
        created,
      }));
      const result = await findOrCreate(
        env.services,
        'Account',
        { field: 'Name', value: 'Concurrent example' },
        { Name: 'Concurrent example' }
      );
      expect(result.created).toBe(created);
      expect(result.record).toMatchObject({ Name: 'Concurrent example', Id: result.id });
    }
  );
  it('plans the same UUID for two concurrent searches missing the same business key', async () => {
    const env = setup();
    const [first, second] = await Promise.all([
      findOrCreate(
        env.services,
        'Account',
        { field: 'Name', value: 'Concurrent example' },
        { Name: 'Concurrent example' }
      ),
      findOrCreate(
        env.services,
        'Account',
        { field: 'Name', value: 'Concurrent example' },
        { Name: 'Concurrent example' }
      ),
    ]);
    expect(first.id).toBe(second.id);
  });
});
