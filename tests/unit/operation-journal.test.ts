import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ServiceContainer } from '../../src/tools/init-tool.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  afterJournalMutation,
  beforeJournalMutation,
  getOperation,
  listOperations,
  MAX_OPERATION_BYTES,
  withOperationJournal,
} from '../../src/server/operation-journal.js';
import { operationView } from '../../src/tools/operation-tool.js';
import { tenantStorageScope, userStorageScope } from '../../src/utils/tenant-scope.js';
import { extractAuthFromHeaders, runWithAuth } from '../../src/auth/request-context.js';
import { HttpClient } from '../../src/client/http-client.js';

const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';
let directory: string;
function services(userId = USER_A, tenant = 'tenant-a'): ServiceContainer {
  return {
    initialized: true,
    config: {
      bpmsoft_url: 'https://bpm.test',
      tenant_id: tenant,
      journal_root: join(directory, 'operations'),
      odata_version: 4,
      platform: 'net8',
      page_size: 100,
      max_batch_size: 100,
      lookup_cache_ttl: 300,
      request_timeout: 5000,
      max_file_size: 1024,
    },
    authManager: { ensureAuthenticated: vi.fn(async () => undefined) },
    currentUser: { get: vi.fn(async () => ({ userId, userName: userId })) },
  } as unknown as ServiceContainer;
}
function scopePath(container: ServiceContainer, userId = USER_A): string {
  return join(container.config.journal_root!, tenantStorageScope(container.config), userStorageScope(userId));
}
const success = (): CallToolResult => ({
  content: [{ type: 'text', text: 'Saved' }],
  structuredContent: { success: true, record_id: 'record-1' },
  _meta: { custom: 'kept' },
});
function idOf(result: CallToolResult): string {
  return result._meta!.operation_id as string;
}
async function complete(container: ServiceContainer): Promise<CallToolResult> {
  return withOperationJournal(container, 'bpm_create_record', { data: { Name: 'Example' } }, async () => {
    const handle = await beforeJournalMutation({
      method: 'POST',
      url: 'https://bpm.test/odata/Contact',
      body: { Name: 'Example' },
      operation: 'mutation',
    });
    await afterJournalMutation(handle, {
      status: 'completed',
      http_status: 201,
      receipt: { Id: 'record-1' },
    });
    return success();
  });
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'bpm-journal-'));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});

describe('durable operation journal', () => {
  it('persists intent and started stage before dispatch, then a receipt without changing the tool contract', async () => {
    const container = services();
    let dispatched = false;
    const result = await withOperationJournal(
      container,
      'bpm_create_record',
      { Name: 'Example' },
      async () => {
        const names = await readdir(scopePath(container));
        const initial = JSON.parse(await readFile(join(scopePath(container), names[0]), 'utf8'));
        expect(initial.status).toBe('started');
        expect(initial.stages).toHaveLength(0);
        const stage = await beforeJournalMutation({
          method: 'POST',
          url: 'https://bpm.test/odata/Contact',
          body: { Name: 'Example' },
        });
        const durable = await getOperation(container, initial.operation_id);
        expect(durable.stages[0].status).toBe('started');
        expect(durable.status).toBe('outcome_unknown');
        dispatched = true;
        await afterJournalMutation(stage, { status: 'completed', http_status: 201 });
        return success();
      }
    );
    expect(dispatched).toBe(true);
    expect(result.structuredContent).toEqual(success().structuredContent);
    expect(result._meta?.custom).toBe('kept');
    const stored = await getOperation(container, idOf(result));
    expect(stored.status).toBe('completed');
    expect(stored.requires_state_verification).toBe(false);
    expect(stored.safe_to_retry).toBe(false);
    expect(stored.receipt).toMatchObject({ _meta: { operation_id: idOf(result) } });
    expect((await lstat(scopePath(container))).mode & 0o777).toBe(0o700);
    expect((await lstat(join(scopePath(container), `${idOf(result)}.json`))).mode & 0o777).toBe(0o600);
  });

  it('isolates two BPMSoft-verified users and two operator-configured tenants', async () => {
    const owner = services();
    const result = await complete(owner);
    for (const other of [services(USER_B), services(USER_A, 'tenant-b'), services(USER_B, 'tenant-b')]) {
      await expect(getOperation(other, idOf(result))).rejects.toMatchObject({
        httpStatus: 404,
        message: 'Операция не найдена.',
      });
    }
    await expect(getOperation(owner, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')).rejects.toMatchObject({
      httpStatus: 404,
      message: 'Операция не найдена.',
    });
  });

  it('rejects a foreign receipt copied under the same UUID into another tenant namespace', async () => {
    const owner = services();
    const foreign = services(USER_A, 'tenant-b');
    const result = await complete(owner);
    await complete(foreign);
    const file = `${idOf(result)}.json`;
    await copyFile(join(scopePath(owner), file), join(scopePath(foreign), file));
    await chmod(join(scopePath(foreign), file), 0o600);
    await expect(getOperation(foreign, idOf(result))).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('does not trust caller-provided user headers or persist auth and binary values', async () => {
    const container = services();
    const result = await runWithAuth(
      extractAuthFromHeaders({
        BPMCSRF: 'raw-csrf',
        Cookie: '.ASPXAUTH=raw-cookie; BPMSESSIONID=raw-session',
        'x-user-id': USER_B,
      }),
      () =>
        withOperationJournal(
          container,
          'bpm_upload_file',
          {
            Cookie: 'raw-cookie',
            password: 'raw-password',
            base64: 'raw-binary',
            file: Buffer.from('raw-bytes'),
          },
          async () => {
            const stage = await beforeJournalMutation({
              method: 'PUT',
              url: 'https://bpm.test/odata/Contact/Photo?token=raw-query-token',
              headers: { Cookie: 'raw-cookie' },
              body: Buffer.from('raw-body-bytes'),
            });
            await afterJournalMutation(stage, {
              status: 'completed',
              http_status: 204,
              receipt: { cookie: 'raw-response-cookie' },
            });
            return { content: [{ type: 'text', text: '{"BPMCSRF":"raw-return-token","Id":"record-1"}' }] };
          }
        )
    );
    const stored = await getOperation(container, idOf(result));
    expect(stored.user_scope).toBe(userStorageScope(USER_A));
    const text = await readFile(join(scopePath(container), `${idOf(result)}.json`), 'utf8');
    for (const secret of [
      'raw-cookie',
      'raw-csrf',
      'raw-session',
      'raw-password',
      'raw-binary',
      'raw-bytes',
      'raw-body-bytes',
      'raw-query-token',
      'raw-response-cookie',
      'raw-return-token',
    ])
      expect(text).not.toContain(secret);
    expect(text).toContain('binary_omitted');
    expect(text).toContain('record-1');
  });

  it('reports incomplete durable state after a fresh module load and never replays it', async () => {
    const container = services();
    const result = await complete(container);
    const path = join(scopePath(container), `${idOf(result)}.json`);
    const stored = JSON.parse(await readFile(path, 'utf8'));
    stored.status = 'started';
    stored.stages[0].status = 'started';
    delete stored.receipt;
    await writeFile(path, JSON.stringify(stored), { mode: 0o600 });
    vi.resetModules();
    const restarted = await import('../../src/server/operation-journal.js');
    const recovered = await restarted.getOperation(container, idOf(result));
    expect(recovered.status).toBe('outcome_unknown');
    expect(recovered.requires_state_verification).toBe(true);
    expect(recovered.safe_to_retry).toBe(false);
    expect(await readFile(path, 'utf8')).toBe(JSON.stringify(stored));
  });

  it('reads missing roots and invalid UUIDs as generic 404 without creating directories', async () => {
    const container = services();
    await expect(getOperation(container, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')).rejects.toMatchObject({
      httpStatus: 404,
    });
    await expect(getOperation(container, '../outside')).rejects.toMatchObject({ httpStatus: 404 });
    await expect(lstat(container.config.journal_root!)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await listOperations(container)).operations).toEqual([]);
    await expect(lstat(container.config.journal_root!)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('discovers operation IDs after a lost response with bounded pages in the verified namespace', async () => {
    const container = services();
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) ids.add(idOf(await complete(container)));
    const first = await listOperations(container, { limit: 2 });
    expect(first.operations).toHaveLength(2);
    expect(first.has_more).toBe(true);
    expect(first.order).toBe('directory');
    const second = await listOperations(container, { offset: first.next_offset, limit: 2 });
    const third = await listOperations(container, { offset: second.next_offset, limit: 2 });
    expect(third.operations).toHaveLength(1);
    expect(third.has_more).toBe(false);
    expect(
      new Set(
        [...first.operations, ...second.operations, ...third.operations].map((item) => item.operation_id)
      )
    ).toEqual(ids);
    expect((await listOperations(services(USER_B))).operations).toEqual([]);
    expect((await listOperations(services(USER_A, 'tenant-b'))).operations).toEqual([]);
  });

  it('preserves verified-user lookup failures instead of claiming that the receipt does not exist', async () => {
    const container = services();
    const result = await complete(container);
    vi.mocked(container.currentUser.get).mockRejectedValueOnce(new Error('BPMSoft offline'));
    await expect(getOperation(container, idOf(result))).rejects.toThrow('BPMSoft offline');
  });

  it('records an uncertain batch item even when the batch envelope was HTTP 200', async () => {
    const container = services();
    const result = await withOperationJournal(container, 'bpm_batch_create', {}, async () => {
      const stage = await beforeJournalMutation({ method: 'POST', url: 'https://bpm.test/odata/$batch' });
      await afterJournalMutation(stage, { status: 'completed', http_status: 200 });
      return {
        content: [{ type: 'text', text: 'One item is uncertain' }],
        structuredContent: { outcomes: [{ state: 'outcome_unknown', record_id: 'record-1' }] },
        isError: true,
      };
    });
    const stored = await getOperation(container, idOf(result));
    expect(stored.status).toBe('outcome_unknown');
    expect(stored.requires_state_verification).toBe(true);
  });

  it('records a successful operation after one definite 401 rejection and safe reauthentication', async () => {
    const container = services();
    const client = new HttpClient(container.config);
    client.setAllowEnvCreds(true);
    const reauthenticate = vi.fn(async () => undefined);
    client.setReauthHandler(reauthenticate);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: 'expired' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ Id: 'record-1' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        })
      );
    vi.stubGlobal('fetch', fetch);
    const result = await withOperationJournal(container, 'bpm_create_record', {}, async () => {
      await client.request({
        method: 'POST',
        url: 'https://bpm.test/odata/Contact',
        body: { Name: 'Example' },
      });
      return success();
    });
    const stored = await getOperation(container, idOf(result));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(reauthenticate).toHaveBeenCalledTimes(1);
    expect(stored.stages.map((stage) => [stage.status, stage.http_status])).toEqual([
      ['failed', 401],
      ['completed', 201],
    ]);
    expect(stored.status).toBe('completed');
    expect(stored.requires_state_verification).toBe(false);
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining(idOf(result)) });
  });

  it('refuses symlink roots and symlink user scopes before executing a handler', async () => {
    const container = services();
    const outside = join(directory, 'outside');
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, container.config.journal_root!);
    const execute = vi.fn(async () => success());
    await expect(withOperationJournal(container, 'bpm_create_record', {}, execute)).rejects.toBeTruthy();
    expect(execute).not.toHaveBeenCalled();
    expect(await readdir(outside)).toEqual([]);
    await rm(container.config.journal_root!);
    await complete(container);
    await rm(scopePath(container), { recursive: true });
    await symlink(outside, scopePath(container));
    await expect(withOperationJournal(container, 'bpm_create_record', {}, execute)).rejects.toBeTruthy();
    expect(execute).not.toHaveBeenCalled();
    expect(await readdir(outside)).toEqual([]);
  });

  it('refuses symlink operation files on read', async () => {
    const container = services();
    const result = await complete(container);
    const path = join(scopePath(container), `${idOf(result)}.json`);
    const outside = join(directory, 'outside.json');
    await copyFile(path, outside);
    await rm(path);
    await symlink(outside, path);
    await expect(getOperation(container, idOf(result))).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('refuses an oversized initial intent before calling any handler', async () => {
    const execute = vi.fn(async () => success());
    await expect(
      withOperationJournal(
        services(),
        'bpm_create_record',
        { Name: 'x'.repeat(MAX_OPERATION_BYTES) },
        execute
      )
    ).rejects.toMatchObject({ httpStatus: 413 });
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses an oversized actual upstream intent before dispatch', async () => {
    const container = services();
    const dispatch = vi.fn();
    const result = await withOperationJournal(container, 'bpm_create_record', {}, async () => {
      await beforeJournalMutation({
        method: 'POST',
        url: 'https://bpm.test/odata/Contact',
        body: { Name: 'x'.repeat(MAX_OPERATION_BYTES) },
      });
      dispatch();
      return success();
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect((await getOperation(container, idOf(result))).status).toBe('outcome_unknown');
  });

  it('keeps the durable incomplete marker when a final receipt cannot be saved', async () => {
    const container = services();
    const result = await withOperationJournal(container, 'bpm_create_record', {}, async () => {
      const stage = await beforeJournalMutation({ method: 'POST', url: 'https://bpm.test/odata/Contact' });
      await afterJournalMutation(stage, { status: 'completed', http_status: 201 });
      return { content: [{ type: 'text', text: 'x'.repeat(MAX_OPERATION_BYTES) }] };
    });
    expect(result._meta).toMatchObject({
      journal_receipt_persisted: false,
      requires_state_verification: true,
    });
    expect(result.content[1]).toMatchObject({ type: 'text', text: expect.stringContaining('не повторяйте') });
    const recovered = await getOperation(container, idOf(result));
    expect(recovered.status).toBe('outcome_unknown');
    expect(recovered.stages[0].status).toBe('completed');
    expect(recovered.receipt).toBeUndefined();
  });

  it('records preview as not_executed and makes legacy/read hooks no-ops', async () => {
    expect(
      await beforeJournalMutation({ method: 'POST', url: 'https://bpm.test/odata/Contact' })
    ).toBeUndefined();
    const container = services();
    const result = await withOperationJournal(container, 'bpm_delete_record', {}, async () => {
      expect(
        await beforeJournalMutation({
          method: 'POST',
          url: 'https://bpm.test/SelectQuery',
          operation: 'read',
        })
      ).toBeUndefined();
      return success();
    });
    expect((await getOperation(container, idOf(result))).status).toBe('not_executed');
  });

  it('marks partial failure as requiring verification and returns bounded paginated journal views', async () => {
    const container = services();
    const result = await withOperationJournal(container, 'bpm_batch_create', {}, async () => {
      for (let i = 0; i < 25; i++) {
        const stage = await beforeJournalMutation({
          method: 'POST',
          url: `https://bpm.test/odata/Contact?part=${i}`,
        });
        await afterJournalMutation(stage, {
          status: i === 24 ? 'failed' : 'completed',
          http_status: i === 24 ? 400 : 201,
          receipt: { details: 'x'.repeat(5000) },
        });
      }
      return { content: [{ type: 'text', text: 'Some records failed' }], isError: true };
    });
    const stored = await getOperation(container, idOf(result));
    expect(stored.status).toBe('failed');
    expect(stored.requires_state_verification).toBe(true);
    const first = operationView(stored);
    expect(first.total_stages).toBe(25);
    expect(first.has_more).toBe(true);
    expect(first.next_stage_offset).toBe(20);
    expect(first.stages as unknown[]).toHaveLength(20);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(48 * 1024);
    expect(operationView(stored, 20, 20).stages as unknown[]).toHaveLength(5);
    const longStages = Array.from({ length: 50 }, (_, index) => ({
      ...stored.stages[0],
      stage_id: index + 1,
      target: 'ю'.repeat(1024),
      intent: { Name: '\\"'.repeat(2048) },
      receipt: { Details: '\\"'.repeat(2048) },
    }));
    const bounded = operationView({ ...stored, stages: longStages }, 0, 50, true);
    const response = {
      content: [{ type: 'text', text: JSON.stringify(bounded) }],
      structuredContent: { operation: bounded },
    };
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(64 * 1024);
  });
});
