/** Required-create invariants are exercised through the registered tool handlers. */
import { describe, expect, it, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceContainer } from '../../src/tools/init-tool.js';
import type { EntityMetadata, EntityProperty } from '../../src/types/index.js';
import { registerWriteTools } from '../../src/tools/write-tools.js';
import { registerBatchTools } from '../../src/tools/batch-tools.js';
import { registerRegisterContactTool } from '../../src/workflows/register-contact.js';
import { registerLogActivityTool } from '../../src/workflows/log-activity.js';
import { registerProcessTools } from '../../src/tools/process-tools.js';
import { findOrCreate } from '../../src/workflows/find-or-create.js';
import { MissingRequiredFieldsError } from '../../src/utils/write-safety.js';
import { LookupResolutionError } from '../../src/utils/errors.js';

const A = 'aaaaaaaa-1111-4111-8111-111111111111';
function field(name: string, type = 'Edm.String', options: Partial<EntityProperty> = {}): EntityProperty {
  return { name, type, nullable: false, isLookup: false, ...options };
}
function entity(name: string, properties: EntityProperty[]): EntityMetadata {
  return {
    name,
    collectionName: name,
    properties: [field('Id', 'Edm.Guid', { required: true }), ...properties],
    lookupFields: properties.filter((p) => p.isLookup).map((p) => p.name),
    cachedAt: Date.now(),
  };
}
function setup() {
  const metas: Record<string, EntityMetadata> = {
    Contact: entity('Contact', [
      field('Name', 'Edm.String', {
        required: true,
        caption: 'ФИО',
        requirementSource: 'entity_schema_designer',
      }),
      field('Email'),
      field('AccountId', 'Edm.Guid', { isLookup: true, lookupCollection: 'Account' }),
    ]),
    Account: entity('Account', [
      field('Name', 'Edm.String', {
        required: true,
        caption: 'Название',
        requirementSource: 'entity_schema_designer',
      }),
      field('OwnerId', 'Edm.Guid', {
        required: true,
        defaultHint: { source: 'runtime', providedByServer: true },
      }),
    ]),
    Activity: entity('Activity', [
      field('Title', 'Edm.String', { required: true, caption: 'Заголовок' }),
      field('StartDate', 'Edm.DateTimeOffset'),
      field('DueDate', 'Edm.DateTimeOffset'),
      field('OwnerId', 'Edm.Guid', { required: true, isLookup: true, lookupCollection: 'Contact' }),
    ]),
    SocialMessage: entity('SocialMessage', [
      field('Message', 'Edm.String', { required: true }),
      field('EntitySchemaUId', 'Edm.Guid'),
      field('EntityId', 'Edm.Guid'),
    ]),
  };
  const createRecord = vi.fn(
    async (_collection: string, data: Record<string, unknown>, options?: { id?: string }) => ({
      ...data,
      Id: options?.id ?? A,
    })
  );
  const odataClient = {
    getRecords: vi.fn(async () => ({ value: [] })),
    getRecord: vi.fn(async (_collection: string, id: string) => ({ Id: id })),
    createRecord,
    createRecordWithOutcome: vi.fn(
      async (collection: string, data: Record<string, unknown>, options?: { id?: string }) => ({
        record: await createRecord(collection, data, options),
        created: true as boolean | null,
      })
    ),
    executeBatch: vi.fn(async () => ({ responses: [] })),
    buildCollectionPath: vi.fn((collection: string) => `/odata/${collection}`),
    buildRecordPath: vi.fn((collection: string, id: string) => `/odata/${collection}(${id})`),
  };
  Object.assign(odataClient, {
    executeBulk: async (requests: unknown[], continueOnError?: boolean) => ({
      ...(await odataClient.executeBatch(requests, continueOnError)),
      mode: 'batch',
    }),
  });
  const services = {
    initialized: true,
    config: { bpmsoft_url: 'https://crm.example.test', username: 'tester', odata_version: 4 },
    authManager: { ensureAuthenticated: vi.fn(async () => undefined) },
    odataClient,
    metadataManager: {
      getEntitySchemaUId: vi.fn(async () => A),
      getEntityMetadata: vi.fn(async (collection: string) => metas[collection]),
      resolveCollectionReference: vi.fn(async (name: string) => ({ name })),
      resolveFieldReference: vi.fn(async (_collection: string, name: string) => ({ name })),
    },
    lookupResolver: {
      createResolutionContext: vi.fn(() => ({
        now: new Date('2026-10-07T10:00:00.000Z'),
        getCurrentUser: vi.fn(async () => ({ userId: A, contactId: A })),
        getTimeZone: vi.fn(async () => ({ timeZone: 'Europe/Moscow', source: 'environment' as const })),
      })),
      resolve: vi.fn(async () => ({ resolved: false, matchCount: 0, candidates: [] })),
      resolveDataLookups: vi.fn(async (_collection: string, data: Record<string, unknown>) => ({
        data,
        notes: [],
      })),
    },
  } as unknown as ServiceContainer;
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<CallToolResult>>();
  const server = {
    registerTool: (
      name: string,
      _meta: unknown,
      handler: (args: Record<string, unknown>) => Promise<CallToolResult>
    ) => handlers.set(name, handler),
  };
  registerWriteTools(server as never, services);
  registerBatchTools(server as never, services);
  registerRegisterContactTool(server as never, services);
  registerLogActivityTool(server as never, services);
  registerProcessTools(server as never, services);
  return {
    services,
    metas,
    odataClient,
    call: (name: string, args: Record<string, unknown>) => handlers.get(name)!(args),
  };
}

describe('known Designer requirements at create boundaries', () => {
  it.each([undefined, false, true])(
    'rejects missing Name independently of legacy strict_required=%j before POST',
    async (strict) => {
      const env = setup();
      const result = await env.call('bpm_create_record', {
        collection: 'Contact',
        data: {},
        strict_required: strict,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        code: 'validation',
        missing_fields: [{ name: 'Name', caption: 'ФИО', type: 'Edm.String' }],
        next_steps: expect.any(Array),
      });
      expect(env.odataClient.createRecord).not.toHaveBeenCalled();
    }
  );
  it('rejects a blank required string while accepting zero and false', async () => {
    const env = setup();
    expect(
      (await env.call('bpm_create_record', { collection: 'Contact', data: { Name: ' ' } })).isError
    ).toBe(true);
    env.metas.Contact.properties.push(
      field('Quantity', 'Edm.Int32', { required: true }),
      field('Enabled', 'Edm.Boolean', { required: true })
    );
    const result = await env.call('bpm_create_record', {
      collection: 'Contact',
      data: { Name: 'Valid', Quantity: 0, Enabled: false },
    });
    expect(result.isError).toBeUndefined();
    expect(env.odataClient.createRecord).toHaveBeenCalledTimes(1);
  });
  it('dry-runs through create preparation and returns retryable normalized arguments without writing', async () => {
    const env = setup();
    const result = await env.call('bpm_create_record', {
      collection: 'Contact',
      data: { Name: 'Valid' },
      dry_run: true,
    });
    expect(result.structuredContent).toMatchObject({
      dry_run: true,
      ready: true,
      normalized_args: { collection: 'Contact', data: { Name: 'Valid' } },
      blockers: [],
    });
    expect(env.odataClient.createRecord).not.toHaveBeenCalled();
    expect(env.odataClient.createRecordWithOutcome).not.toHaveBeenCalled();
  });
  it('dry-run aggregates lookup blockers and retains failed explicit values for correction/replay', async () => {
    const env = setup();
    env.metas.Contact.properties.push(
      field('OwnerId', 'Edm.Guid', { required: true, isLookup: true, lookupCollection: 'Contact' }),
      field('AccountId', 'Edm.Guid', { required: true, isLookup: true, lookupCollection: 'Account' })
    );
    vi.mocked(env.services.lookupResolver.resolveDataLookups).mockImplementationOnce(
      async (_collection, _data) => ({
        data: { Name: 'Valid' },
        notes: [],
        coerced: [],
        errors: [
          {
            rawKey: 'OwnerId',
            canonicalField: 'OwnerId',
            error: new LookupResolutionError('OwnerId', 'Unknown owner', 0, [], {
              validValues: ['Supervisor'],
            }),
          },
          {
            rawKey: 'AccountId',
            canonicalField: 'AccountId',
            error: new LookupResolutionError('AccountId', 'Unknown account', 0, [], {
              validValues: ['Acme'],
            }),
          },
        ],
      })
    );
    const result = await env.call('bpm_create_record', {
      collection: 'Contact',
      data: { Name: 'Valid', OwnerId: 'Unknown owner', AccountId: 'Unknown account' },
      dry_run: true,
    });
    expect(result.structuredContent).toMatchObject({
      ready: false,
      blockers: [
        { field: 'OwnerId', valid_values: ['Supervisor'] },
        { field: 'AccountId', valid_values: ['Acme'] },
      ],
      normalized_args: {
        data: { Name: 'Valid', OwnerId: 'Unknown owner', AccountId: 'Unknown account' },
      },
    });
    expect(env.odataClient.createRecordWithOutcome).not.toHaveBeenCalled();
  });
  it('does not infer caller requirements from non-nullable EDM fields or autoassigned Id', async () => {
    const env = setup();
    const result = await env.call('bpm_create_record', {
      collection: 'Contact',
      data: { Name: 'Valid' },
      strict_required: true,
    });
    expect(result.isError).toBeUndefined();
    expect(env.odataClient.createRecord.mock.calls[0][1]).toEqual({ Name: 'Valid' });
  });
  it.each([
    { source: 'runtime', providedByServer: true },
    { source: 'system_setting', providedByServer: true },
  ])('allows omission of fields with known platform default %j', async (defaultHint) => {
    const env = setup();
    env.metas.Contact.properties.push(
      field('PlatformField', 'Edm.String', {
        required: true,
        defaultHint: defaultHint as EntityProperty['defaultHint'],
      })
    );
    expect(
      (await env.call('bpm_create_record', { collection: 'Contact', data: { Name: 'Valid' } })).isError
    ).toBeUndefined();
  });
  it.each([
    ['Edm.Int32', 0],
    ['Edm.Boolean', false],
  ] as const)('accepts typed zero/false defaults for %s', async (type, value) => {
    const env = setup();
    env.metas.Contact.properties.push(
      field('PlatformField', type, {
        required: true,
        defaultHint: { source: 'constant', providedByServer: true, value },
      })
    );
    const result = await env.call('bpm_create_record', { collection: 'Contact', data: { Name: 'Valid' } });
    expect(result.isError).toBeUndefined();
  });
  it('does not treat blank or zero-GUID constants as satisfying required defaults', async () => {
    for (const [type, value] of [
      ['Edm.String', ''],
      ['Edm.Guid', '00000000-0000-0000-0000-000000000000'],
      ['Edm.Guid', 'not-a-guid'],
      ['Edm.Int32', Number.NaN],
      ['Edm.Boolean', 'maybe'],
    ] as const) {
      const env = setup();
      env.metas.Contact.properties.push(
        field('PlatformField', type, {
          required: true,
          defaultHint: { source: 'constant', providedByServer: true, value },
        })
      );
      const result = await env.call('bpm_create_record', { collection: 'Contact', data: { Name: 'Valid' } });
      expect(result.structuredContent?.missing_fields).toEqual([
        { name: 'PlatformField', caption: 'PlatformField', type },
      ]);
      expect(env.odataClient.createRecord).not.toHaveBeenCalled();
    }
  });
  it('does not trust unknown default provenance even when marked server-provided', async () => {
    const env = setup();
    env.metas.Contact.properties.push(
      field('Uncertain', 'Edm.String', {
        required: true,
        defaultHint: { source: 'unknown', providedByServer: true, value: 'x' },
      })
    );
    const result = await env.call('bpm_create_record', { collection: 'Contact', data: { Name: 'Valid' } });
    expect(result.structuredContent?.missing_fields).toEqual([
      { name: 'Uncertain', caption: 'Uncertain', type: 'Edm.String' },
    ]);
  });
  it('does not assume an unknown default will satisfy a required field', async () => {
    const env = setup();
    env.metas.Contact.properties.push(
      field('Uncertain', 'Edm.String', { required: true, defaultHint: { source: 'unknown' } })
    );
    const result = await env.call('bpm_create_record', { collection: 'Contact', data: { Name: 'Valid' } });
    expect(result.structuredContent?.missing_fields).toEqual([
      { name: 'Uncertain', caption: 'Uncertain', type: 'Edm.String' },
    ]);
    expect(env.odataClient.createRecord).not.toHaveBeenCalled();
  });
  it('preflights every batch record before executing any part of the batch', async () => {
    const env = setup();
    const result = await env.call('bpm_batch_create', {
      collection: 'Contact',
      records: [{ Name: 'First' }, {}],
    });
    expect(result.structuredContent?.missing_fields).toEqual([
      { name: 'Name', caption: 'ФИО', type: 'Edm.String' },
    ]);
    expect(env.odataClient.executeBatch).not.toHaveBeenCalled();
    expect(env.odataClient.createRecord).not.toHaveBeenCalled();
  });
  it('batch dry-run returns normalized ready rows and blockers without sending a write', async () => {
    const env = setup();
    const result = await env.call('bpm_batch_create', {
      collection: 'Contact',
      records: [{ Name: 'First' }, {}],
      continue_on_error: true,
      dry_run: true,
    });
    expect(result.structuredContent).toMatchObject({
      dry_run: true,
      ready: false,
      normalized_args: {
        collection: 'Contact',
        records: [{ Name: 'First', Id: expect.any(String) }, {}],
        continue_on_error: true,
      },
      errors: [{ index: 1 }],
    });
    expect(env.odataClient.executeBatch).not.toHaveBeenCalled();
  });
  it('reports missing contact fields before creating an account', async () => {
    const env = setup();
    env.metas.Contact.properties.push(
      field('RequiredPhone', 'Edm.String', { required: true, caption: 'Телефон' })
    );
    const result = await env.call('bpm_register_contact', { name: 'Ivan', account_name: 'Example' });
    expect(result.structuredContent?.missing_fields).toEqual([
      { name: 'RequiredPhone', caption: 'Телефон', type: 'Edm.String' },
    ]);
    expect(env.odataClient.createRecord).not.toHaveBeenCalled();
  });
  it('reports missing workflow Name before account planning or writing', async () => {
    const env = setup();
    const result = await env.call('bpm_register_contact', { name: '', account_name: 'Example' });
    expect(result.structuredContent?.missing_fields).toEqual([
      { name: 'Name', caption: 'ФИО', type: 'Edm.String' },
    ]);
    expect(env.odataClient.getRecords).not.toHaveBeenCalled();
    expect(env.odataClient.createRecord).not.toHaveBeenCalled();
  });
  it('enforces requirements in find-or-create only when a new record is needed', async () => {
    const env = setup();
    await expect(
      findOrCreate(env.services, 'Account', { field: 'Name', value: 'Example' }, {})
    ).rejects.toBeInstanceOf(MissingRequiredFieldsError);
    expect(env.odataClient.createRecord).not.toHaveBeenCalled();
    env.odataClient.getRecords.mockResolvedValue({ value: [{ Id: A, Name: 'Example' }] } as never);
    expect(
      await findOrCreate(env.services, 'Account', { field: 'Name', value: 'Example' }, {})
    ).toMatchObject({ id: A, created: false });
  });
  it('checks additional required Activity fields before creating', async () => {
    const env = setup();
    const result = await env.call('bpm_log_activity', { title: 'Call' });
    expect(result.structuredContent?.missing_fields).toEqual([
      { name: 'OwnerId', caption: 'OwnerId', type: 'Edm.Guid' },
    ]);
    expect(env.odataClient.createRecord).not.toHaveBeenCalled();
  });
  it('preflights additional required feed fields before publishing', async () => {
    const env = setup();
    env.metas.SocialMessage.properties.push(
      field('CategoryId', 'Edm.Guid', { required: true, caption: 'Категория' })
    );
    const result = await env.call('bpm_post_feed', { collection: 'Contact', id: A, message: 'Update' });
    expect(result.structuredContent?.missing_fields).toEqual([
      { name: 'CategoryId', caption: 'Категория', type: 'Edm.Guid' },
    ]);
    expect(env.odataClient.createRecord).not.toHaveBeenCalled();
  });
});

describe('explicit empty required values', () => {
  it.each([null, '00000000-0000-0000-0000-000000000000'])(
    'does not replace an explicitly empty required lookup %j with a platform default',
    async (value) => {
      const env = setup();
      env.metas.Contact.properties.push(
        field('OwnerId', 'Edm.Guid', {
          required: true,
          defaultHint: { source: 'runtime', providedByServer: true },
        })
      );
      const result = await env.call('bpm_create_record', {
        collection: 'Contact',
        data: { Name: 'Valid', OwnerId: value },
      });
      expect(result.structuredContent?.missing_fields).toEqual([
        { name: 'OwnerId', caption: 'OwnerId', type: 'Edm.Guid' },
      ]);
      expect(env.odataClient.createRecord).not.toHaveBeenCalled();
    }
  );
});
