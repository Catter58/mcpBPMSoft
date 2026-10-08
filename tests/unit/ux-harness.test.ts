import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, symlink, writeFile, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createMutationGuard,
  initialState,
  parseOptions,
  readOwnerFile,
  readState,
  writeOwnerState,
} from '../../scripts/lib/ux-harness.mjs';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';
const UUID_D = '44444444-4444-4444-8444-444444444444';
const MARKER = 'test_Marker_123';
const TEST_ORIGIN = 'https://crm.example.invalid';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function fakeFetch(status = 204) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return new Response(null, { status });
  });
  return { calls, fetchImpl };
}

function mutationUrl(method: string, collection = 'Account', id = UUID_A) {
  return method === 'POST'
    ? `${TEST_ORIGIN}/odata/${collection}`
    : `${TEST_ORIGIN}/odata/${collection}(${id})`;
}

describe('UX harness mutation guard', () => {
  it('requires an explicit exact HTTPS origin', () => {
    const fake = fakeFetch();
    expect(() => createMutationGuard(fake.fetchImpl)).toThrow(/exact HTTPS target origin/);
    expect(() => createMutationGuard(fake.fetchImpl, 'https://crm.example.invalid/odata')).toThrow(
      /exact HTTPS target origin/
    );
    expect(() => createMutationGuard(fake.fetchImpl, 'http://crm.example.invalid')).toThrow(
      /exact HTTPS target origin/
    );
  });

  it('pins the host and rejects a cross-origin nested read probe without forwarding', async () => {
    const fake = fakeFetch();
    const guard = createMutationGuard(fake.fetchImpl, TEST_ORIGIN);
    await expect(guard.guardedFetch('https://evil.example/odata/Account')).rejects.toThrow(
      /Pinned target origin/
    );
    const crossOriginProbe = JSON.stringify({
      requests: [{ id: '1', method: 'GET', url: 'https://evil.example/odata/Account?$select=Id&$top=1' }],
    });
    await expect(
      guard.guardedFetch(`${TEST_ORIGIN}/odata/$batch`, { method: 'POST', body: crossOriginProbe })
    ).rejects.toThrow(/read-only probe/);
    expect(fake.fetchImpl).not.toHaveBeenCalled();
    expect(guard.readProbes).toEqual([]);
  });

  it('blocks every non-OData mutation and always rejects PUT', async () => {
    const fake = fakeFetch();
    const guard = createMutationGuard(fake.fetchImpl, TEST_ORIGIN);
    const cases: Array<[string, string]> = [
      ['POST', `${TEST_ORIGIN}/ServiceModel/OtherService.svc/Execute`],
      ['PATCH', `${TEST_ORIGIN}/0/DataService/json/SyncReply/SelectQuery`],
      ['DELETE', `${TEST_ORIGIN}/ServiceModel/AuthService.svc/Logout`],
      ['PUT', mutationUrl('POST')],
    ];
    for (const [method, url] of cases)
      await expect(guard.guardedFetch(url, { method, body: '{}' })).rejects.toThrow();
    await expect(
      guard.guardedFetch(`${TEST_ORIGIN}/odata/Account`, {
        method: 'GET',
        headers: { 'X-HTTP-Method-Override': 'DELETE' },
      })
    ).rejects.toThrow(/method override/);
    expect(fake.fetchImpl).not.toHaveBeenCalled();
    expect(guard.stats()).toMatchObject({ attempts: 0, forwarded: 0, blocked: 5 });
  });

  it('permits only exact collection or UUID record paths, exact bodies, and consumes permission once', async () => {
    const fake = fakeFetch(204);
    const guard = createMutationGuard(fake.fetchImpl, TEST_ORIGIN);
    const createBody = { Id: UUID_A, Name: `MCP UX ${MARKER} A` };
    guard.permit({ method: 'POST', collection: 'Account', body: createBody });
    await expect(
      guard.guardedFetch(`${TEST_ORIGIN}/odata/Account/Extra`, {
        method: 'POST',
        body: JSON.stringify(createBody),
      })
    ).rejects.toThrow(/exact fixture paths/);
    await expect(
      guard.guardedFetch(mutationUrl('POST'), {
        method: 'POST',
        body: JSON.stringify({ ...createBody, Notes: 'extra' }),
      })
    ).rejects.toThrow(/one-shot/);
    await guard.guardedFetch(mutationUrl('POST'), { method: 'POST', body: JSON.stringify(createBody) });
    await expect(
      guard.guardedFetch(mutationUrl('POST'), {
        method: 'POST',
        body: JSON.stringify(createBody),
      })
    ).rejects.toThrow(/one-shot/);

    const patchBody = { Name: `MCP UX ${MARKER} A updated` };
    guard.permit({ method: 'PATCH', collection: 'Account', id: UUID_A, body: patchBody });
    await expect(
      guard.guardedFetch(`${TEST_ORIGIN}/odata/Account(${UUID_A})/Anything`, {
        method: 'PATCH',
        body: JSON.stringify(patchBody),
      })
    ).rejects.toThrow(/exact fixture paths/);
    await expect(
      guard.guardedFetch(`${TEST_ORIGIN}/0/odata/Account(${UUID_A})`, {
        method: 'PATCH',
        body: JSON.stringify(patchBody),
      })
    ).rejects.toThrow(/Non-OData mutation/);
    await expect(
      guard.guardedFetch(`${mutationUrl('PATCH')}?select=Id`, {
        method: 'PATCH',
        body: JSON.stringify(patchBody),
      })
    ).rejects.toThrow(/exact fixture paths/);
    await expect(
      guard.guardedFetch(mutationUrl('PATCH', 'Activity', UUID_A), {
        method: 'PATCH',
        body: JSON.stringify(patchBody),
      })
    ).rejects.toThrow(/one-shot/);
    await guard.guardedFetch(mutationUrl('PATCH'), { method: 'PATCH', body: JSON.stringify(patchBody) });

    guard.permit({ method: 'DELETE', collection: 'Account', id: UUID_A });
    await expect(
      guard.guardedFetch(mutationUrl('DELETE', 'Account', UUID_B), { method: 'DELETE' })
    ).rejects.toThrow(/one-shot/);
    await guard.guardedFetch(mutationUrl('DELETE'), { method: 'DELETE' });

    expect(fake.fetchImpl).toHaveBeenCalledTimes(3);
    expect(guard.stats()).toMatchObject({ attempts: 3, forwarded: 3, forwarded_successful: 3, injected: 0 });
    expect(guard.stats().statuses).toEqual([
      expect.objectContaining({
        method: 'POST',
        collection: 'Account',
        id: UUID_A,
        status: 204,
        forwarded: true,
      }),
      expect.objectContaining({
        method: 'PATCH',
        collection: 'Account',
        id: UUID_A,
        status: 204,
        forwarded: true,
      }),
      expect.objectContaining({
        method: 'DELETE',
        collection: 'Account',
        id: UUID_A,
        status: 204,
        forwarded: true,
      }),
    ]);
    expect(JSON.stringify(guard.stats())).not.toContain('MCP UX');
    expect(JSON.stringify(guard.stats())).not.toContain(TEST_ORIGIN);
  });

  it('forwards only the exact schema discovery POST from the read-only service allowlist', async () => {
    const fake = fakeFetch(200);
    const guard = createMutationGuard(fake.fetchImpl, TEST_ORIGIN);
    const path = `${TEST_ORIGIN}/ServiceModel/EntitySchemaDesignerService.svc/GetSchema`;
    const body = JSON.stringify({ schemaUId: UUID_A });
    const response = await guard.guardedFetch(path, { method: 'POST', body });
    expect(response.status).toBe(200);
    expect(fake.fetchImpl).toHaveBeenCalledTimes(1);
    await expect(guard.guardedFetch(`${path}?extra=1`, { method: 'POST', body })).rejects.toThrow();
    await expect(
      guard.guardedFetch(`${TEST_ORIGIN}/ServiceModel/EntitySchemaDesignersService.svc/GetSchema`, {
        method: 'POST',
        body,
      })
    ).rejects.toThrow();
    expect(fake.fetchImpl).toHaveBeenCalledTimes(1);
    expect(guard.readProbes).toEqual([{ kind: 'read_only_service_post', status: 200 }]);
    expect(guard.stats()).toMatchObject({ attempts: 0, read_probes: 1 });
  });

  it('answers only the exact fixed nested GET probe with 405 and records it separately', async () => {
    const fake = fakeFetch();
    const guard = createMutationGuard(fake.fetchImpl, TEST_ORIGIN);
    const response = await guard.guardedFetch(`${TEST_ORIGIN}/odata/$batch`, {
      method: 'POST',
      body: JSON.stringify({
        requests: [
          {
            id: '1',
            method: 'GET',
            url: '/odata/Activity?$select=Id&$top=1',
            headers: { 'Content-Type': 'application/json' },
          },
        ],
      }),
    });
    expect(response.status).toBe(405);
    expect(fake.fetchImpl).not.toHaveBeenCalled();
    expect(guard.readProbes).toEqual([
      { kind: 'nested_odata_get', collection: 'Activity', method: 'GET', status: 405 },
    ]);
    expect(guard.stats()).toMatchObject({ attempts: 0, injected: 0, forwarded: 0, read_probes: 1 });
  });

  it('consumes a synthetic 400 permission without forwarding a write', async () => {
    const fake = fakeFetch(204);
    const guard = createMutationGuard(fake.fetchImpl, TEST_ORIGIN);
    const body = { Name: `MCP UX ${MARKER} B` };
    guard.permit({ method: 'PATCH', collection: 'Account', id: UUID_B, body, action: 'stub400' });
    const response = await guard.guardedFetch(mutationUrl('PATCH', 'Account', UUID_B), {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
    expect(fake.fetchImpl).not.toHaveBeenCalled();
    expect(guard.stats()).toMatchObject({ attempts: 1, injected: 1, forwarded: 0, forwarded_successful: 0 });
    expect(guard.stats().statuses[0]).toMatchObject({ status: 400, injected: true, forwarded: false });
  });

  it('injects a local fault only after one successful forwarded PATCH', async () => {
    const fake = fakeFetch(204);
    const guard = createMutationGuard(fake.fetchImpl, TEST_ORIGIN);
    const body = { Name: `MCP UX ${MARKER} C` };
    guard.permit({ method: 'PATCH', collection: 'Account', id: UUID_C, body, fault: true });
    await expect(
      guard.guardedFetch(mutationUrl('PATCH', 'Account', UUID_C), {
        method: 'PATCH',
        body: JSON.stringify(body),
      })
    ).rejects.toThrow(/after one forwarded fixture PATCH/);
    expect(fake.fetchImpl).toHaveBeenCalledTimes(1);
    expect(guard.stats()).toMatchObject({ attempts: 1, injected: 1, forwarded: 1, forwarded_successful: 1 });
    expect(guard.stats().statuses[0]).toMatchObject({
      status: 204,
      injected: true,
      forwarded: true,
      forwarded_success: true,
    });
  });
});

describe('UX harness owner state', () => {
  async function privateDir() {
    const dir = await mkdtemp(join(tmpdir(), 'ux-harness-test-'));
    tempDirs.push(dir);
    return dir;
  }

  it('writes atomically as 0600 and validates exact marker-derived fixture identities', async () => {
    const dir = await privateDir();
    const path = join(dir, 'state.json');
    const state = initialState(MARKER);
    await writeOwnerState(path, state);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readState(path, MARKER)).toEqual(state);
    expect(JSON.parse(await readFile(path, 'utf8')).account_names).toEqual([
      `MCP UX ${MARKER} A`,
      `MCP UX ${MARKER} B`,
      `MCP UX ${MARKER} C`,
    ]);
    expect(state.activity_id).not.toBe(state.account_ids[0]);
  });

  it('accepts inspect as an authenticated state stage', () => {
    expect(
      parseOptions([
        '--inspect',
        '--auth',
        'private-auth.json',
        '--state',
        'private-state.json',
        '--marker',
        MARKER,
      ])
    ).toMatchObject({
      stage: 'inspect',
      auth: 'private-auth.json',
      state: 'private-state.json',
      marker: MARKER,
    });
    expect(() => parseOptions(['--inspect', '--marker', MARKER])).toThrow(
      /requires --auth, --state, and --marker/
    );
  });

  it.each([
    [
      'duplicate Account UUIDs',
      (state: ReturnType<typeof initialState>) => {
        state.account_ids[1] = state.account_ids[0];
      },
    ],
    [
      'extra Account UUID',
      (state: ReturnType<typeof initialState>) => {
        state.account_ids.push(UUID_D);
      },
    ],
    [
      'wrong marker-derived name',
      (state: ReturnType<typeof initialState>) => {
        state.account_names[0] += ' changed';
      },
    ],
    [
      'wrong marker-derived title',
      (state: ReturnType<typeof initialState>) => {
        state.activity_title += ' changed';
      },
    ],
    [
      'invalid stage flag',
      (state: ReturnType<typeof initialState>) => {
        (state as unknown as Record<string, unknown>).fault_started = 'yes';
      },
    ],
    [
      'foreign auth material',
      (state: ReturnType<typeof initialState>) => {
        (state as unknown as Record<string, unknown>).password = 'secret';
      },
    ],
  ])('rejects malformed private state: %s', async (_name, mutate) => {
    const dir = await privateDir();
    const path = join(dir, 'state.json');
    const state = initialState(MARKER);
    mutate(state);
    await writeFile(path, JSON.stringify(state), { mode: 0o600 });
    await expect(readState(path, MARKER)).rejects.toThrow();
  });

  it('rejects group-readable files, symlinks, and unsafe existing targets', async () => {
    const dir = await privateDir();
    const permissive = join(dir, 'permissive.json');
    await writeFile(permissive, '{}', { mode: 0o644 });
    await chmod(permissive, 0o644);
    await expect(readOwnerFile(permissive)).rejects.toThrow(/0600/);

    const safe = join(dir, 'safe.json');
    await writeFile(safe, '{}', { mode: 0o600 });
    const link = join(dir, 'linked.json');
    await symlink(safe, link);
    await expect(readOwnerFile(link)).rejects.toThrow(/0600/);
    await expect(writeOwnerState(link, initialState(MARKER))).rejects.toThrow(/0600/);
    await expect(writeOwnerState(permissive, initialState(MARKER))).rejects.toThrow(/0600/);
  });
});
