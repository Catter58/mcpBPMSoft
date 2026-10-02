/** Regression tests against real registered tool handlers. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceContainer } from '../../src/tools/init-tool.js';
import { registerWriteTools } from '../../src/tools/write-tools.js';
import { registerBatchTools } from '../../src/tools/batch-tools.js';
import { BpmApiError } from '../../src/utils/errors.js';
import { runWithAuth } from '../../src/auth/request-context.js';

const A = 'aaaaaaaa-1111-4111-8111-111111111111';
const B = 'bbbbbbbb-2222-4222-8222-222222222222';
const C = 'cccccccc-3333-4333-8333-333333333333';
function setup() {
  const odataClient = {
    getRecords: vi.fn(async () => ({
      value: [
        { Id: A, Name: 'A' },
        { Id: B, Name: 'B' },
      ],
    })),
    getRecord: vi.fn(async (_collection: string, id: string) => ({
      Id: id,
      Name: 'A',
      '@odata.etag': 'W/"1"',
    })),
    updateRecord: vi.fn(async () => undefined),
    deleteRecord: vi.fn(async () => undefined),
    assertExpectedEtag: vi.fn(async () => undefined),
    createRecord: vi.fn(
      async (_collection: string, data: Record<string, unknown>, options?: { id?: string }) => ({
        ...data,
        Id: options?.id,
      })
    ),
    createRecordWithOutcome: vi.fn(
      async (_collection: string, data: Record<string, unknown>, options?: { id?: string }) => ({
        record: await odataClient.createRecord(_collection, data, options),
        created: true as boolean | null,
      })
    ),
    buildCollectionPath: vi.fn((collection: string) => `/odata/${collection}`),
    buildRecordPath: vi.fn((collection: string, id: string) => `/odata/${collection}(${id})`),
    executeBatch: vi.fn(async (requests: unknown[]) => ({
      responses: requests.map((_, index) => ({ id: String(index + 1), status: 204, body: null })),
    })),
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
    metadataManager: {
      resolveCollectionReference: vi.fn(async (name: string) => ({ name })),
      resolveFieldReference: vi.fn(async (_collection: string, name: string) => ({
        name: name === 'Имя' ? 'Name' : name,
      })),
      getLookupInfo: vi.fn(async () => null),
      getEntityMetadata: vi.fn(async () => ({
        properties: [
          { name: 'Name', caption: 'Имя', type: 'Edm.String' },
          { name: 'CreatedOn', type: 'Edm.DateTimeOffset' },
        ],
      })),
    },
    lookupResolver: {
      resolveDataLookups: vi.fn(async (_collection: string, data: Record<string, unknown>) => ({
        data,
        notes: [],
      })),
    },
    odataClient,
  } as unknown as ServiceContainer;
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<CallToolResult>>();
  const server = {
    registerTool: (
      name: string,
      _config: unknown,
      handler: (args: Record<string, unknown>) => Promise<CallToolResult>
    ) => handlers.set(name, handler),
  };
  registerWriteTools(server as never, services);
  registerBatchTools(server as never, services);
  return {
    services,
    odataClient,
    call: (name: string, args: Record<string, unknown>) => handlers.get(name)!(args),
  };
}
async function confirmedCall(env: ReturnType<typeof setup>, name: string, args: Record<string, unknown>) {
  const preview = await env.call(name, args);
  return env.call(name, {
    ...args,
    confirm: true,
    confirmation_token: preview.structuredContent?.confirmation_token,
  });
}
afterEach(() => vi.useRealTimers());

const selection = { collection: 'Contact', filter: "Name ne ''", expected_count: 2 };
describe('snapshot confirmation', () => {
  it('rejects confirm without a preview for single and mass deletes', async () => {
    const env = setup();
    for (const [name, args] of [
      ['bpm_delete_record', { collection: 'Contact', id: A }],
      ['bpm_delete_by_filter', selection],
      ['bpm_batch_delete', { collection: 'Contact', ids: [A, B] }],
    ] as const) {
      expect((await env.call(name, { ...args, confirm: true })).isError).toBe(true);
    }
    expect(env.odataClient.deleteRecord).not.toHaveBeenCalled();
    expect(env.odataClient.executeBatch).not.toHaveBeenCalled();
  });
  it('rejects same-size replacement of matching records', async () => {
    const env = setup();
    const preview = await env.call('bpm_delete_by_filter', selection);
    env.odataClient.getRecords.mockResolvedValue({
      value: [
        { Id: A, Name: 'A' },
        { Id: C, Name: 'C' },
      ],
    });
    const result = await env.call('bpm_delete_by_filter', {
      ...selection,
      confirm: true,
      confirmation_token: preview.structuredContent?.confirmation_token,
    });
    expect(result.isError).toBe(true);
    expect(env.odataClient.deleteRecord).not.toHaveBeenCalled();
  });
  it('rejects changed content even with identical matching UUIDs', async () => {
    const env = setup();
    const preview = await env.call('bpm_delete_by_filter', selection);
    env.odataClient.getRecords.mockResolvedValue({
      value: [
        { Id: A, Name: 'Changed' },
        { Id: B, Name: 'B' },
      ],
    });
    expect(
      (
        await env.call('bpm_delete_by_filter', {
          ...selection,
          confirm: true,
          confirmation_token: preview.structuredContent?.confirmation_token,
        })
      ).isError
    ).toBe(true);
    expect(env.odataClient.deleteRecord).not.toHaveBeenCalled();
  });
  it('rejects update payload changes and allows the original bound payload', async () => {
    const env = setup();
    const args = { ...selection, data: { Name: 'New' } };
    const preview = await env.call('bpm_update_by_filter', args);
    const token = preview.structuredContent?.confirmation_token;
    expect(env.odataClient.updateRecord).not.toHaveBeenCalled();
    expect(
      (
        await env.call('bpm_update_by_filter', {
          ...args,
          data: { Name: 'Other' },
          confirm: true,
          confirmation_token: token,
        })
      ).isError
    ).toBe(true);
    expect(env.odataClient.updateRecord).not.toHaveBeenCalled();
    expect(
      (await env.call('bpm_update_by_filter', { ...args, confirm: true, confirmation_token: token })).isError
    ).toBe(false);
    expect(env.odataClient.updateRecord).toHaveBeenCalledTimes(2);
  });
  it('tokens expire, cannot be replayed, and cannot move between principals', async () => {
    const env = setup();
    const args = { collection: 'Contact', id: A };
    const authA = { cookies: new Map([['BPMSESSIONID', 'session-a']]) };
    const authB = { cookies: new Map([['BPMSESSIONID', 'session-b']]) };
    const preview = await runWithAuth(authA, () => env.call('bpm_delete_record', args));
    const confirmed = {
      ...args,
      confirm: true,
      confirmation_token: preview.structuredContent?.confirmation_token,
    };
    expect((await runWithAuth(authB, () => env.call('bpm_delete_record', confirmed))).isError).toBe(true);
    expect(
      (await runWithAuth(authA, () => env.call('bpm_delete_record', confirmed))).isError
    ).toBeUndefined();
    expect((await runWithAuth(authA, () => env.call('bpm_delete_record', confirmed))).isError).toBe(true);
    expect(env.odataClient.deleteRecord).toHaveBeenCalledTimes(1);
    vi.useFakeTimers();
    const newPreview = await env.call('bpm_delete_record', args);
    vi.advanceTimersByTime(10 * 60_000 + 1);
    expect(
      (
        await env.call('bpm_delete_record', {
          ...args,
          confirm: true,
          confirmation_token: newPreview.structuredContent?.confirmation_token,
        })
      ).isError
    ).toBe(true);
    expect(env.odataClient.deleteRecord).toHaveBeenCalledTimes(1);
  });
  it('materializes bounded pages and rejects an incomplete selection', async () => {
    const env = setup();
    env.odataClient.getRecords.mockResolvedValue({
      value: [
        { Id: A, Name: 'A' },
        { Id: B, Name: 'B' },
      ],
      '@odata.nextLink': '/odata/Contact?skip=2',
    } as never);
    const result = await env.call('bpm_delete_by_filter', selection);
    expect(result.isError).toBe(true);
    expect(env.odataClient.getRecords).toHaveBeenCalledWith(
      'Contact',
      { $filter: selection.filter, $top: 3, $orderby: 'Id', $count: true },
      true,
      3
    );
    expect(env.odataClient.deleteRecord).not.toHaveBeenCalled();
  });
  it('uses the preview ETag when deleting a record', async () => {
    const env = setup();
    const args = { collection: 'Contact', id: A };
    const preview = await env.call('bpm_delete_record', args);
    await env.call('bpm_delete_record', {
      ...args,
      confirm: true,
      confirmation_token: preview.structuredContent?.confirmation_token,
    });
    expect(env.odataClient.deleteRecord).toHaveBeenCalledWith('Contact', A, { expectedEtag: 'W/"1"' });
  });
  it('returns committed, unknown and unexecuted IDs and stops after an uncertain write', async () => {
    const env = setup();
    env.odataClient.getRecords.mockResolvedValue({
      value: [
        { Id: A, Name: 'A' },
        { Id: B, Name: 'B' },
        { Id: C, Name: 'C' },
      ],
    });
    const args = { ...selection, expected_count: 3 };
    const preview = await env.call('bpm_delete_by_filter', args);
    env.odataClient.deleteRecord
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(
        new BpmApiError(
          'Unknown response',
          502,
          'Contact',
          undefined,
          undefined,
          undefined,
          'outcome_unknown'
        )
      );
    const result = await env.call('bpm_delete_by_filter', {
      ...args,
      confirm: true,
      confirmation_token: preview.structuredContent?.confirmation_token,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.outcomes).toEqual([
      { id: A, state: 'succeeded' },
      { id: B, state: 'outcome_unknown', error: 'Unknown response' },
      { id: C, state: 'not_executed' },
    ]);
    expect(env.odataClient.deleteRecord).toHaveBeenCalledTimes(2);
  });
});

describe('batch result correlation', () => {
  it('renders a compact outcome while preserving the complete response in structured data', async () => {
    const env = setup();
    const body = { Id: A, Name: 'Readable account', Description: 'Large response data '.repeat(5000) };
    env.odataClient.executeBatch.mockResolvedValue({ responses: [{ id: '1', status: 201, body }] } as never);
    const result = await env.call('bpm_batch_create', {
      collection: 'Contact',
      records: [{ Id: A, Name: body.Name }],
    });
    const text = result.content
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('');
    expect(text.length).toBeLessThan(350);
    expect(text).toContain('Readable account');
    expect(text).toContain(A);
    expect(text).not.toContain('Description');
    expect(result.structuredContent?.outcomes).toEqual([expect.objectContaining({ body })]);
  });
  it('maps shuffled responses by request ID, preserving input indices and record UUIDs', async () => {
    const env = setup();
    env.odataClient.executeBatch.mockResolvedValue({
      responses: [
        { id: '2', status: 400, body: { error: 'Rule' } },
        { id: '1', status: 201, body: { Id: A } },
      ],
    } as never);
    const result = await env.call('bpm_batch_create', {
      collection: 'Contact',
      records: [
        { Id: A, Name: 'A' },
        { Id: B, Name: 'B' },
      ],
    });
    expect(result.structuredContent).toMatchObject({
      first_failed_index: 1,
      created: [A, null],
      outcomes: [
        expect.objectContaining({ index: 0, request_id: '1', record_id: A, state: 'succeeded' }),
        expect.objectContaining({ index: 1, request_id: '2', record_id: B, state: 'failed' }),
      ],
    });
  });
  it('marks missing and duplicate IDs unknown rather than counting them as success', async () => {
    const env = setup();
    env.odataClient.executeBatch.mockResolvedValue({
      responses: [
        { id: '1', status: 204, body: null },
        { id: '1', status: 204, body: null },
      ],
    });
    const result = await confirmedCall(env, 'bpm_batch_update', {
      collection: 'Contact',
      updates: [
        { id: A, data: { Name: 'A' } },
        { id: B, data: { Name: 'B' } },
      ],
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.succeeded).toBe(0);
    expect(result.structuredContent?.outcomes).toEqual([
      expect.objectContaining({ state: 'outcome_unknown' }),
      expect.objectContaining({ state: 'outcome_unknown' }),
    ]);
  });
  it('preserves runtime statuses for unexecuted and unknown requests', async () => {
    const env = setup();
    env.odataClient.executeBatch.mockResolvedValue({
      responses: [
        { id: '1', status: 0, body: null, state: 'outcome_unknown' },
        { id: '2', status: 0, body: null, state: 'not_executed' },
      ],
    } as never);
    const result = await confirmedCall(env, 'bpm_batch_update', {
      collection: 'Contact',
      updates: [
        { id: A, data: { Name: 'A' } },
        { id: B, data: { Name: 'B' } },
      ],
    });
    expect(result.structuredContent?.outcomes).toEqual([
      expect.objectContaining({ record_id: A, state: 'outcome_unknown' }),
      expect.objectContaining({ record_id: B, state: 'not_executed' }),
    ]);
  });
  it('forwards version preconditions in batch update', async () => {
    const env = setup();
    await confirmedCall(env, 'bpm_batch_update', {
      collection: 'Contact',
      updates: [{ id: A, data: { Name: 'A' }, expected_etag: 'W/"2"' }],
    });
    expect(env.odataClient.executeBatch.mock.calls[0][0]).toEqual([
      { method: 'PATCH', url: `/odata/Contact(${A})`, body: { Name: 'A' }, headers: { 'If-Match': 'W/"2"' } },
    ]);
  });
});

describe('semantic bulk selection', () => {
  it.each(['bpm_update_by_filter', 'bpm_delete_by_filter'] as const)(
    'compiles captions for %s and preserves a readable plan',
    async (name) => {
      const env = setup();
      const args = {
        collection: 'Contact',
        criteria: [{ field: 'Имя', op: 'содержит', value: "O'Reilly" }],
        expected_count: 2,
        ...(name === 'bpm_update_by_filter' ? { data: { Name: 'New' } } : {}),
      };
      const preview = await env.call(name, args);
      expect(preview.isError).toBeUndefined();
      expect(preview.structuredContent).toMatchObject({
        compiled_filter: "contains(tolower(Name), 'o''reilly')",
        used_fields: [{ input: 'Имя', resolved: 'Name', caption: 'Имя' }],
        records: [
          { id: A, display_value: 'A' },
          { id: B, display_value: 'B' },
        ],
      });
      expect(env.odataClient.getRecords).toHaveBeenCalledWith(
        'Contact',
        { $filter: "contains(tolower(Name), 'o''reilly')", $top: 3, $orderby: 'Id', $count: true },
        true,
        3
      );
      const result = await env.call(name, {
        ...args,
        confirm: true,
        confirmation_token: preview.structuredContent?.confirmation_token,
      });
      expect(result.isError).toBe(false);
      expect(
        name === 'bpm_update_by_filter' ? env.odataClient.updateRecord : env.odataClient.deleteRecord
      ).toHaveBeenCalledTimes(2);
    }
  );
  it.each(['bpm_update_by_filter', 'bpm_delete_by_filter'] as const)(
    'rejects absent and empty selection for %s',
    async (name) => {
      const env = setup();
      for (const selection of [{}, { filter: '' }, { criteria: [] }]) {
        expect(
          (
            await env.call(name, {
              collection: 'Contact',
              expected_count: 2,
              data: name === 'bpm_update_by_filter' ? { Name: 'New' } : undefined,
              ...selection,
            })
          ).isError
        ).toBe(true);
      }
      expect(env.odataClient.getRecords).not.toHaveBeenCalled();
      expect(env.odataClient.updateRecord).not.toHaveBeenCalled();
      expect(env.odataClient.deleteRecord).not.toHaveBeenCalled();
    }
  );
  it('binds original criteria and join even if altered criteria return identical records', async () => {
    const env = setup();
    const args = {
      collection: 'Contact',
      criteria: [
        { field: 'Name', op: 'contains', value: 'A' },
        { field: 'Name', op: 'contains', value: 'B' },
      ],
      join: 'or',
      expected_count: 2,
    };
    const preview = await env.call('bpm_delete_by_filter', args);
    const confirmed = {
      ...args,
      confirm: true,
      confirmation_token: preview.structuredContent?.confirmation_token,
    };
    expect((await env.call('bpm_delete_by_filter', { ...confirmed, join: 'and' })).isError).toBe(true);
    expect(
      (
        await env.call('bpm_delete_by_filter', {
          ...confirmed,
          criteria: [{ field: 'Name', op: 'contains', value: 'Different' }],
        })
      ).isError
    ).toBe(true);
    expect(env.odataClient.deleteRecord).not.toHaveBeenCalled();
    expect((await env.call('bpm_delete_by_filter', confirmed)).isError).toBe(false);
  });
  it('recompiles relative dates at confirmation without invalidating an unchanged record snapshot', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
    const env = setup();
    const args = {
      collection: 'Contact',
      criteria: [{ field: 'CreatedOn', op: 'in_last_days', value: 7 }],
      expected_count: 2,
    };
    const preview = await env.call('bpm_delete_by_filter', args);
    vi.advanceTimersByTime(60_000);
    const result = await env.call('bpm_delete_by_filter', {
      ...args,
      confirm: true,
      confirmation_token: preview.structuredContent?.confirmation_token,
    });
    expect(result.isError).toBe(false);
    expect(env.odataClient.getRecords.mock.calls[0][1]).not.toEqual(
      env.odataClient.getRecords.mock.calls[1][1]
    );
    expect(result.structuredContent?.compiled_filter).not.toBe(preview.structuredContent?.compiled_filter);
    expect(env.odataClient.deleteRecord).toHaveBeenCalledTimes(2);
  });
  it('rejects changed contents after criteria are reselected', async () => {
    const env = setup();
    const args = {
      collection: 'Contact',
      criteria: [{ field: 'Name', op: 'contains', value: 'A' }],
      expected_count: 2,
    };
    const preview = await env.call('bpm_delete_by_filter', args);
    env.odataClient.getRecords.mockResolvedValue({
      value: [
        { Id: A, Name: 'Changed' },
        { Id: B, Name: 'B' },
      ],
    });
    const result = await env.call('bpm_delete_by_filter', {
      ...args,
      confirm: true,
      confirmation_token: preview.structuredContent?.confirmation_token,
    });
    expect(result.isError).toBe(true);
    expect(env.odataClient.deleteRecord).not.toHaveBeenCalled();
  });
});

describe('creation intent and readable previews', () => {
  it.each(['', ' ', 'x'.repeat(201)])(
    'rejects invalid direct-handler idempotency key %j before creating',
    async (key) => {
      const env = setup();
      const result = await env.call('bpm_create_record', {
        collection: 'Contact',
        data: { Name: 'Example' },
        idempotency_key: key,
      });
      expect(result.isError).toBe(true);
      expect(env.odataClient.createRecord).not.toHaveBeenCalled();
      expect(result.structuredContent?.code).toBe('validation');
    }
  );
  it('rejects an explicit UUID conflicting with the key rather than overwriting it', async () => {
    const env = setup();
    const result = await env.call('bpm_create_record', {
      collection: 'Contact',
      data: { Id: A, Name: 'Example' },
      idempotency_key: 'one-contact',
    });
    expect(result.isError).toBe(true);
    expect(env.odataClient.createRecord).not.toHaveBeenCalled();
  });
  it('provides display values, captions and an honest snapshot capability', async () => {
    const env = setup();
    const preview = await env.call('bpm_update_by_filter', { ...selection, data: { Name: 'New' } });
    expect(preview.structuredContent).toMatchObject({
      records: [
        { id: A, display_value: 'A' },
        { id: B, display_value: 'B' },
      ],
      data_fields: [{ field: 'Name', caption: 'Имя', value: 'New' }],
      concurrency_protection: 'snapshot_only',
    });
  });
  it('requires confirmation for batch updates and rejects changed snapshots', async () => {
    const env = setup();
    const args = { collection: 'Contact', updates: [{ id: A, data: { Name: 'New' } }] };
    expect((await env.call('bpm_batch_update', { ...args, confirm: true })).isError).toBe(true);
    expect(env.odataClient.executeBatch).not.toHaveBeenCalled();
    const preview = await env.call('bpm_batch_update', args);
    expect(preview.structuredContent).toMatchObject({
      changes: [{ id: A, fields: [{ field: 'Name', caption: 'Имя', value: 'New' }] }],
      concurrency_protection: 'etag',
    });
    env.odataClient.getRecord.mockResolvedValue({ Id: A, Name: 'Changed', '@odata.etag': 'W/"2"' });
    expect(
      (
        await env.call('bpm_batch_update', {
          ...args,
          confirm: true,
          confirmation_token: preview.structuredContent?.confirmation_token,
        })
      ).isError
    ).toBe(true);
    expect(env.odataClient.executeBatch).not.toHaveBeenCalled();
  });
});

describe('selection completeness and mutation phases', () => {
  it('rejects a known total count contradicting a complete-looking page', async () => {
    const env = setup();
    env.odataClient.getRecords.mockResolvedValue({
      value: [
        { Id: A, Name: 'A' },
        { Id: B, Name: 'B' },
      ],
      '@odata.count': 3,
    } as never);
    const result = await env.call('bpm_delete_by_filter', selection);
    expect(result.isError).toBe(true);
    expect(env.odataClient.deleteRecord).not.toHaveBeenCalled();
    expect(result.structuredContent?.error).toContain('total_count=3');
  });
  it('marks update lookup reads and delete preview reads as not executed', async () => {
    const env = setup();
    env.services.lookupResolver.resolveDataLookups = vi.fn(async () => {
      throw new BpmApiError('Lookup read failed', 502);
    }) as never;
    const updated = await env.call('bpm_update_record', {
      collection: 'Contact',
      id: A,
      data: { Name: 'New' },
    });
    expect(updated.structuredContent?.state).toBe('not_executed');
    expect(env.odataClient.updateRecord).not.toHaveBeenCalled();
    env.odataClient.getRecord.mockRejectedValue(new BpmApiError('Preview read failed', 502));
    const deleted = await env.call('bpm_delete_record', { collection: 'Contact', id: A });
    expect(deleted.structuredContent?.state).toBe('not_executed');
    expect(env.odataClient.deleteRecord).not.toHaveBeenCalled();
  });
});

describe('new-main behavior with write safeguards', () => {
  it('combines raw filters and semantic criteria and binds both to confirmation', async () => {
    const env = setup();
    const args = { ...selection, criteria: [{ field: 'Имя', op: 'eq', value: 'A' }], data: { Name: 'New' } };
    const preview = await env.call('bpm_update_by_filter', args);
    expect(preview.isError).toBeUndefined();
    expect(preview.structuredContent?.compiled_filter).toContain("Name ne ''");
    expect(preview.structuredContent?.compiled_filter).toContain("Name eq 'A'");
    expect(env.odataClient.updateRecord).not.toHaveBeenCalled();
    const confirm = {
      ...args,
      confirm: true,
      confirmation_token: preview.structuredContent?.confirmation_token,
    };
    expect(
      (await env.call('bpm_update_by_filter', { ...confirm, filter: "Name eq 'Changed'" })).isError
    ).toBe(true);
    expect(env.odataClient.updateRecord).not.toHaveBeenCalled();
    expect((await env.call('bpm_update_by_filter', confirm)).isError).toBe(false);
    expect(env.odataClient.updateRecord).toHaveBeenCalledTimes(2);
  });
  it('requires a snapshot-bound plan for batch match_on updates', async () => {
    const env = setup();
    const args = { collection: 'Contact', records: [{ Name: 'A' }], match_on: ['Name'], if_exists: 'update' };
    const preview = await env.call('bpm_batch_create', args);
    expect(preview.structuredContent?.requires_confirmation).toBe(true);
    expect(env.odataClient.executeBatch).not.toHaveBeenCalled();
    env.odataClient.getRecord.mockResolvedValue({ Id: A, Name: 'Changed', '@odata.etag': 'W/"2"' });
    expect(
      (
        await env.call('bpm_batch_create', {
          ...args,
          confirm: true,
          confirmation_token: preview.structuredContent?.confirmation_token,
        })
      ).isError
    ).toBe(true);
    expect(env.odataClient.executeBatch).not.toHaveBeenCalled();
    env.odataClient.getRecord.mockResolvedValue({ Id: A, Name: 'A', '@odata.etag': 'W/"1"' });
    expect(
      (
        await env.call('bpm_batch_create', {
          ...args,
          confirm: true,
          confirmation_token: preview.structuredContent?.confirmation_token,
        })
      ).isError
    ).toBe(false);
    expect(env.odataClient.executeBatch).toHaveBeenCalledTimes(1);
  });
  it('attaches only metadata-known Decimal and Int64 fields to native batch requests', async () => {
    const env = setup();
    env.services.metadataManager.getEntityMetadata = vi.fn(async () => ({
      properties: [
        { name: 'Amount', type: 'Edm.Decimal' },
        { name: 'Counter', type: 'Edm.Int64' },
        { name: 'Name', type: 'Edm.String' },
      ],
    })) as never;
    const result = await env.call('bpm_batch_create', {
      collection: 'Contact',
      records: [{ Amount: '9007199254740993.01', Counter: '9223372036854775807', Name: '00123' }],
    });
    expect(result.isError).toBe(false);
    expect(env.odataClient.executeBatch.mock.calls[0][0]).toEqual([
      expect.objectContaining({
        body: expect.objectContaining({
          Amount: '9007199254740993.01',
          Counter: '9223372036854775807',
          Name: '00123',
        }),
        numericFields: ['Amount', 'Counter'],
      }),
    ]);
  });
  it.each(['bpm_update_by_filter', 'bpm_batch_update'])(
    'does not recalculate parents after an uncertain line write in %s',
    async (name) => {
      const env = setup();
      const rows = [
        { Id: A, Name: 'A', OrderId: C, Price: 10, Quantity: 1 },
        { Id: B, Name: 'B', OrderId: C, Price: 20, Quantity: 1 },
      ];
      env.odataClient.getRecords.mockResolvedValue({ value: rows });
      env.odataClient.getRecord.mockImplementation(async (_collection, id) => ({
        ...rows.find((row) => row.Id === id)!,
        '@odata.etag': 'W/"1"',
      }));
      env.odataClient.updateRecord.mockImplementation(async (collection, id) => {
        if (collection === 'OrderProduct' && id === B)
          throw new BpmApiError(
            'Неопределённый исход записи',
            0,
            collection,
            undefined,
            undefined,
            undefined,
            'outcome_unknown'
          );
      });
      env.odataClient.executeBatch.mockResolvedValue({
        responses: [
          { id: '1', status: 204, body: null, state: 'completed' },
          { id: '2', status: 0, body: null, state: 'outcome_unknown' },
        ],
      } as never);
      const args =
        name === 'bpm_update_by_filter'
          ? { collection: 'OrderProduct', filter: "Name ne ''", expected_count: 2, data: { Quantity: 2 } }
          : {
              collection: 'OrderProduct',
              updates: [
                { id: A, data: { Quantity: 2 } },
                { id: B, data: { Quantity: 2 } },
              ],
            };
      const result = await confirmedCall(env, name, args);
      expect(result.isError).toBe(true);
      expect(result.structuredContent?.outcomes).toEqual([
        expect.objectContaining({ state: 'succeeded' }),
        expect.objectContaining({ state: 'outcome_unknown' }),
      ]);
      expect(
        env.odataClient.updateRecord.mock.calls.every(([collection]) => collection === 'OrderProduct')
      ).toBe(true);
      expect(result.structuredContent?.line_items_notes).toEqual(
        expect.arrayContaining([expect.stringContaining('не пересчитаны')])
      );
      expect(
        env.odataClient.getRecord.mock.calls.every(([collection]) => collection === 'OrderProduct')
      ).toBe(true);
    }
  );
  it('does not recalculate a parent after a create was reconciled from an uncertain response', async () => {
    const env = setup();
    env.odataClient.createRecordWithOutcome.mockResolvedValue({
      record: { Id: A, Name: 'Line' },
      created: null,
    });
    const result = await env.call('bpm_create_record', {
      collection: 'OrderProduct',
      data: { OrderId: C, Name: 'Line', Price: 10, Quantity: 1 },
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.created).toBeNull();
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('Запись обнаружена'),
    });
    expect(env.odataClient.updateRecord).not.toHaveBeenCalled();
    expect(result.structuredContent?.line_items_notes).toEqual(
      expect.arrayContaining([expect.stringContaining('не пересчитаны')])
    );
  });
});

describe('line deletion parent selection', () => {
  it.each(['bpm_delete_by_filter', 'bpm_batch_delete'])(
    'recalculates only parents of definitely deleted snapshots in %s',
    async (name) => {
      const env = setup();
      const otherParent = 'dddddddd-4444-4444-8444-444444444444';
      const rows = [
        { Id: A, Name: 'A', OrderId: C, TotalAmount: 10 },
        { Id: B, Name: 'B', OrderId: otherParent, TotalAmount: 20 },
      ];
      env.odataClient.getRecords.mockResolvedValue({ value: rows });
      env.odataClient.getRecord.mockImplementation(async (collection, id) =>
        collection === 'Order'
          ? { Id: id, Name: 'Order', '@odata.etag': 'W/"1"', CurrencyRate: 1 }
          : { ...rows.find((row) => row.Id === id)!, '@odata.etag': 'W/"1"' }
      );
      env.odataClient.deleteRecord.mockImplementation(async (collection, id) => {
        if (id === B) throw new BpmApiError('Deletion denied', 403, collection);
      });
      env.odataClient.executeBatch.mockResolvedValue({
        responses: [
          { id: '1', status: 204, body: null, state: 'completed' },
          { id: '2', status: 403, body: null, state: 'failed' },
        ],
      } as never);
      const args =
        name === 'bpm_delete_by_filter'
          ? { collection: 'OrderProduct', filter: "Name ne ''", expected_count: 2 }
          : { collection: 'OrderProduct', ids: [A, B] };
      const result = await confirmedCall(env, name, args);
      expect(result.isError).toBe(true);
      expect(env.odataClient.updateRecord.mock.calls).toHaveLength(1);
      expect(env.odataClient.updateRecord).toHaveBeenCalledWith('Order', C, expect.any(Object));
      expect(
        env.odataClient.getRecord.mock.calls
          .filter(([collection]) => collection === 'Order')
          .map(([, id]) => id)
      ).toEqual([C]);
    }
  );
});
