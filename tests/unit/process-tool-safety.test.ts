import { describe, expect, it, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceContainer } from '../../src/tools/init-tool.js';
import { registerProcessTools } from '../../src/tools/process-tools.js';
import { BpmApiError } from '../../src/utils/errors.js';
const A = 'aaaaaaaa-1111-4111-8111-111111111111';
const B = 'bbbbbbbb-2222-4222-8222-222222222222';
function setup() {
  const processEngine = {
    execute: vi.fn(async () => ({ status: 200, result: 'done', raw: '' })),
    execProcElByUId: vi.fn(async () => ({ status: 200, raw: '' })),
  };
  const odataClient = {
    getRecord: vi.fn(async (_collection: string, id: string) => ({
      Id: id,
      EntityId: A,
      EntitySchemaUId: A,
    })),
    createRecord: vi.fn(
      async (_collection: string, data: Record<string, unknown>, options?: { id?: string }) => ({
        ...data,
        Id: options?.id,
      })
    ),
  };
  const services = {
    initialized: true,
    config: { bpmsoft_url: 'https://crm.example.test', username: 'tester' },
    authManager: { ensureAuthenticated: vi.fn(async () => undefined) },
    processEngine,
    odataClient,
    metadataManager: {
      getEntitySchemaUId: vi.fn(async () => A),
      resolveCollectionReference: vi.fn(async (name: string) => ({ name })),
      getEntityMetadata: vi.fn(async () => ({ properties: [] })),
    },
    lookupResolver: {
      resolveDataLookups: vi.fn(async (_collection: string, data: Record<string, unknown>) => ({
        data,
        notes: [],
      })),
    },
  } as unknown as ServiceContainer;
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<CallToolResult>>();
  registerProcessTools(
    {
      registerTool: (
        name: string,
        _meta: unknown,
        handler: (args: Record<string, unknown>) => Promise<CallToolResult>
      ) => handlers.set(name, handler),
    } as never,
    services
  );
  return {
    processEngine,
    odataClient,
    call: (name: string, args: Record<string, unknown>) => handlers.get(name)!(args),
  };
}
describe('process tool execution plans', () => {
  it('previews process input, executes once and rejects replay or changed parameters', async () => {
    const env = setup();
    const args = { process_name: 'UsrExample', parameters: { Id: A } };
    const preview = await env.call('bpm_run_process', args);
    expect(env.processEngine.execute).not.toHaveBeenCalled();
    const token = preview.structuredContent?.confirmation_token;
    expect(
      (
        await env.call('bpm_run_process', {
          ...args,
          parameters: { Id: B },
          confirm: true,
          confirmation_token: token,
        })
      ).isError
    ).toBe(true);
    expect(
      (await env.call('bpm_run_process', { ...args, confirm: true, confirmation_token: token })).isError
    ).toBeUndefined();
    expect(
      (await env.call('bpm_run_process', { ...args, confirm: true, confirmation_token: token })).isError
    ).toBe(true);
    expect(env.processEngine.execute).toHaveBeenCalledTimes(1);
  });
  it('marks a lost response unknown and gives no automatic retry instruction', async () => {
    const env = setup();
    env.processEngine.execute.mockRejectedValue(
      new BpmApiError('Lost response', 502, undefined, undefined, undefined, undefined, 'outcome_unknown')
    );
    const args = { process_name: 'UsrExample' };
    const preview = await env.call('bpm_run_process', args);
    const result = await env.call('bpm_run_process', {
      ...args,
      confirm: true,
      confirmation_token: preview.structuredContent?.confirmation_token,
    });
    expect(result.structuredContent).toMatchObject({ state: 'outcome_unknown', code: 'outcome_unknown' });
    expect(env.processEngine.execute).toHaveBeenCalledTimes(1);
  });
  it('rejects invalid process identifiers before execution', async () => {
    const env = setup();
    expect((await env.call('bpm_run_process', { process_name: 'Bad/Process', confirm: true })).isError).toBe(
      true
    );
    expect(env.processEngine.execute).not.toHaveBeenCalled();
  });
  it('binds element confirmation to exact UID', async () => {
    const env = setup();
    const preview = await env.call('bpm_exec_process_element', { element_uid: A });
    expect(
      (
        await env.call('bpm_exec_process_element', {
          element_uid: B,
          confirm: true,
          confirmation_token: preview.structuredContent?.confirmation_token,
        })
      ).isError
    ).toBe(true);
    expect(env.processEngine.execProcElByUId).not.toHaveBeenCalled();
  });
});
describe('feed intent validation', () => {
  it('rejects replies to a message belonging to another record', async () => {
    const env = setup();
    env.odataClient.getRecord.mockResolvedValue({ Id: B, EntityId: B, EntitySchemaUId: A });
    expect(
      (await env.call('bpm_post_feed', { collection: 'Contact', id: A, message: 'Reply', parent_id: B }))
        .isError
    ).toBe(true);
    expect(env.odataClient.createRecord).not.toHaveBeenCalled();
  });
  it('uses a stable message UUID and rejects blank idempotency keys', async () => {
    const env = setup();
    const args = { collection: 'Contact', id: A, message: 'Update', idempotency_key: 'one-message' };
    await env.call('bpm_post_feed', args);
    await env.call('bpm_post_feed', args);
    expect(env.odataClient.createRecord.mock.calls[0][2]?.id).toBe(
      env.odataClient.createRecord.mock.calls[1][2]?.id
    );
    expect((await env.call('bpm_post_feed', { ...args, idempotency_key: ' ' })).isError).toBe(true);
    expect(env.odataClient.createRecord).toHaveBeenCalledTimes(2);
  });
});
