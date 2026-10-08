import { describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerBatchTools } from '../../src/tools/batch-tools.js';
import type { ServiceContainer } from '../../src/tools/init-tool.js';

type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;
const ACCOUNT_ID = 'aaaaaaaa-0000-0000-0000-000000000001';

function setup() {
  const created: Array<{ collection: string; data: Record<string, unknown>; id: string }> = [];
  const entities: Record<string, { properties: Array<Record<string, unknown>> }> = {
    Account: {
      properties: [
        { name: 'Id', type: 'Edm.Guid' },
        { name: 'Name', type: 'Edm.String' },
      ],
    },
    Contact: {
      properties: [
        { name: 'Id', type: 'Edm.Guid' },
        { name: 'Name', type: 'Edm.String' },
        { name: 'AccountId', type: 'Edm.Guid', isLookup: true, lookupCollection: 'Account' },
      ],
    },
  };
  const services = {
    config: { bpmsoft_url: 'https://crm.example.test', odata_version: 4 },
    initialized: true,
    authManager: { ensureAuthenticated: async () => undefined },
    currentUser: { get: async () => ({ userId: ACCOUNT_ID, userName: 'User' }) },
    metadataManager: {
      getEntityMetadata: async (collection: string) => entities[collection],
      resolveCollectionReference: async (collection: string) => ({ name: collection }),
      resolveFieldReference: async (collection: string, field: string) => {
        const property = entities[collection]?.properties.find(
          (item) => item.name?.toLowerCase() === field.toLowerCase()
        );
        return property ? { name: property.name } : { name: null, suggestions: [] };
      },
    },
    lookupResolver: {
      createResolutionContext: () => ({
        now: new Date(),
        getCurrentUser: async () => ({ userId: ACCOUNT_ID }),
      }),
      resolveDataLookups: async (_collection: string, data: Record<string, unknown>) => ({
        data: { ...data },
        notes: [],
        coerced: [],
        errors: [],
      }),
    },
    odataClient: {
      createRecordWithOutcome: async (
        collection: string,
        data: Record<string, unknown>,
        options: { id: string }
      ) => {
        created.push({ collection, data, id: options.id });
        return { record: { ...data, Id: options.id }, created: true };
      },
      getRecords: async () => ({ value: [] }),
    },
  };
  const handlers = new Map<string, Handler>();
  registerBatchTools(
    {
      registerTool: (name: string, _schema: unknown, handler: Handler) => handlers.set(name, handler),
    } as never,
    services as unknown as ServiceContainer
  );
  return { created, call: (args: Record<string, unknown>) => handlers.get('bpm_batch_create')!(args) };
}

describe('bpm_batch_create steps mode', () => {
  it('prepares references first, executes topologically, and reports original indices', async () => {
    const env = setup();
    const args = {
      steps: [
        { alias: 'contact', collection: 'Contact', record: { Name: 'C', accountid: { $ref: 'account' } } },
        { alias: 'account', collection: 'Account', record: { Name: 'A' } },
      ],
    };
    const preview = await env.call(args);
    expect(env.created).toHaveLength(0);
    expect(preview.structuredContent?.requires_confirmation).toBe(true);
    const result = await env.call({
      ...(preview.structuredContent?.normalized_args as Record<string, unknown>),
      confirm: true,
      confirmation_token: preview.structuredContent?.confirmation_token,
    });
    expect(env.created.map((item) => item.collection)).toEqual(['Account', 'Contact']);
    expect(env.created[1].data.AccountId).toBe(env.created[0].id);
    expect(result.structuredContent?.created).toEqual([env.created[1].id, env.created[0].id]);
    expect(result.structuredContent?.step_results.map((step: { index: number }) => step.index)).toEqual([
      0, 1,
    ]);
    expect(result.isError).toBeUndefined();
  });

  it('rejects a bad token before creating any related record', async () => {
    const env = setup();
    const preview = await env.call({
      steps: [{ alias: 'account', collection: 'Account', record: { Name: 'A' } }],
    });
    const rejected = await env.call({
      ...(preview.structuredContent?.normalized_args as Record<string, unknown>),
      confirm: true,
      confirmation_token: 'not-the-token',
    });
    expect(env.created).toHaveLength(0);
    expect(rejected.isError).toBe(true);
  });

  it('rejects references in non-GUID or wrong-target lookup fields before writes', async () => {
    const env = setup();
    const result = await env.call({
      steps: [
        { alias: 'account', collection: 'Account', record: { Name: { $ref: 'other' } } },
        { alias: 'other', collection: 'Account', record: { Name: 'A' } },
      ],
    });
    expect(env.created).toHaveLength(0);
    expect(result.isError).toBe(true);
  });
});
