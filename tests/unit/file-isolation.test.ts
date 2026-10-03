import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getRequestAuth, runWithAuth, type RequestAuth } from '../../src/auth/request-context.js';
import type { BpmConfig } from '../../src/types/index.js';
import type { ServiceContainer } from '../../src/tools/init-tool.js';
import { CurrentUserService } from '../../src/user/current-user.js';
import { saveDownload, uploadPath } from '../../src/utils/file-access.js';
import { tenantStorageScope, userStorageScope } from '../../src/utils/tenant-scope.js';
import { BpmApiError } from '../../src/utils/errors.js';

const ALICE = '11111111-2222-4333-8444-555555555555';
const BOB = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
let root: string;
let outside: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'bpm-private-files-')));
  outside = await realpath(await mkdtemp(join(tmpdir(), 'bpm-outside-files-')));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]);
});

function auth(session: string, extra: Partial<RequestAuth> = {}): RequestAuth {
  return { csrfToken: 'csrf', cookies: new Map([['BPMSESSIONID', session]]), ...extra };
}

function fixture(tenant = 'tenant-one', url = 'https://bpm.example', ttl = 300) {
  const config: BpmConfig = {
    bpmsoft_url: url,
    tenant_id: tenant,
    username: '',
    password: '',
    odata_version: 4,
    platform: 'net8',
    page_size: 100,
    max_batch_size: 100,
    lookup_cache_ttl: ttl,
    request_timeout: 30000,
    max_file_size: 1024,
    file_root: root,
  };
  const request = vi.fn(async () => {
    const session = getRequestAuth()?.cookies.get('BPMSESSIONID') ?? '';
    const id = session.startsWith('bob')
      ? BOB
      : session.startsWith('user-')
        ? `12345678-1234-4234-8234-${Number(session.slice(5)).toString(16).padStart(12, '0')}`
        : ALICE;
    return { status: 200, data: { rows: [{ Id: id, Name: session }], success: true } };
  });
  const currentUser = new CurrentUserService(config, { request } as never);
  const services = { config, currentUser } as ServiceContainer;
  const path = (user: string, name: string) =>
    join(root, tenantStorageScope(config), userStorageScope(user), name);
  return { config, services, currentUser, request, path };
}

describe('verified BPMSoft user and tenant file isolation', () => {
  it('uses private hash directories and preserves files after session renewal', async () => {
    const { services, request, path } = fixture();
    await runWithAuth(auth('alice-old'), () => saveDownload(services, 'report.txt', Buffer.from('alice')));
    const target = await runWithAuth(auth('alice-new'), () => uploadPath(services, 'report.txt'));
    expect(target).toBe(path(ALICE, 'report.txt'));
    expect((await readFile(target)).toString()).toBe('alice');
    expect(request).toHaveBeenCalledTimes(2);
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(target))).mode & 0o777).toBe(0o700);
    expect((await stat(dirname(dirname(target)))).mode & 0o777).toBe(0o700);
    expect(await runWithAuth(auth('alice-new'), () => uploadPath(services, target))).toBe(target);
  });

  it('never opens another user namespace or the shared exchange root', async () => {
    const { services, path } = fixture();
    await runWithAuth(auth('alice'), () => saveDownload(services, 'secret.txt', Buffer.from('alice')));
    await writeFile(join(root, 'shared.txt'), 'shared');
    await expect(runWithAuth(auth('bob'), () => uploadPath(services, 'secret.txt'))).rejects.toMatchObject({
      httpStatus: 404,
    });
    for (const target of [path(ALICE, 'secret.txt'), join(root, 'shared.txt'), '../secret.txt']) {
      await expect(runWithAuth(auth('bob'), () => uploadPath(services, target))).rejects.toMatchObject({
        httpStatus: 403,
      });
      await expect(
        runWithAuth(auth('bob'), () => saveDownload(services, target, Buffer.from('changed')))
      ).rejects.toMatchObject({ httpStatus: 403 });
    }
    expect((await readFile(path(ALICE, 'secret.txt'))).toString()).toBe('alice');
  });

  it('separates tenants with the same verified user UUID, including a changed URL', async () => {
    const one = fixture('one');
    const two = fixture('two');
    const moved = fixture('one', 'https://other-bpm.example');
    await runWithAuth(auth('alice'), () => saveDownload(one.services, 'same.txt', Buffer.from('tenant-one')));
    for (const other of [two, moved]) {
      await expect(
        runWithAuth(auth('alice'), () => uploadPath(other.services, 'same.txt'))
      ).rejects.toMatchObject({
        httpStatus: 404,
      });
      await expect(
        runWithAuth(auth('alice'), () => uploadPath(other.services, one.path(ALICE, 'same.txt')))
      ).rejects.toMatchObject({ httpStatus: 403 });
      await runWithAuth(auth('alice'), () => saveDownload(other.services, 'same.txt', Buffer.from('other')));
      expect(other.path(ALICE, 'same.txt')).not.toBe(one.path(ALICE, 'same.txt'));
    }
  });

  it('derives identity from the BPMSoft macro and ignores incoming identity claims', async () => {
    const { services, path, request } = fixture();
    const forged = { ...auth('bob', { tenantId: 'forged-tenant' }), userId: ALICE };
    await runWithAuth(forged, () => saveDownload(services, 'mine.txt', Buffer.from('bob')));
    expect((await readFile(path(BOB, 'mine.txt'))).toString()).toBe('bob');
    await expect(readFile(path(ALICE, 'mine.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    const body = (request.mock.calls[0] as unknown as [{ body: unknown }])[0].body;
    expect(JSON.stringify(body)).toContain('"macrosType":1');
  });

  it('rejects file, intermediate-directory and managed-directory symlinks', async () => {
    const { services, path, config } = fixture();
    await runWithAuth(auth('alice'), () => saveDownload(services, 'seed', Buffer.from('seed')));
    const secret = join(outside, 'secret');
    await writeFile(secret, 'secret');
    await symlink(secret, path(ALICE, 'file-link'));
    await symlink(outside, path(ALICE, 'dir-link'));
    for (const name of ['file-link', 'dir-link/secret']) {
      await expect(runWithAuth(auth('alice'), () => uploadPath(services, name))).rejects.toMatchObject({
        httpStatus: 403,
      });
      await expect(
        runWithAuth(auth('alice'), () => saveDownload(services, name, Buffer.from('changed')))
      ).rejects.toMatchObject({ httpStatus: 403 });
    }
    expect((await readFile(secret)).toString()).toBe('secret');
    await symlink(outside, join(root, tenantStorageScope(config), userStorageScope(BOB)));
    await expect(
      runWithAuth(auth('bob'), () => saveDownload(services, 'new', Buffer.from('x')))
    ).rejects.toMatchObject({ httpStatus: 403 });
    const other = fixture('symlinked-tenant');
    await symlink(outside, join(root, tenantStorageScope(other.config)));
    await expect(
      runWithAuth(auth('alice'), () => saveDownload(other.services, 'new', Buffer.from('x')))
    ).rejects.toMatchObject({ httpStatus: 403 });
  });

  it('creates only managed hash directories and refuses arbitrary missing parents', async () => {
    const { services, path } = fixture();
    await expect(
      runWithAuth(auth('alice'), () => saveDownload(services, 'missing/sub/file', Buffer.from('x')))
    ).rejects.toMatchObject({ httpStatus: 404 });
    await expect(stat(path(ALICE, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      runWithAuth({ cookies: new Map() }, () => saveDownload(services, 'file', Buffer.from('x')))
    ).rejects.toMatchObject({ httpStatus: 401 });
  });

  it('fails closed when BPMSoft cannot verify the current user', async () => {
    const { services, request, config } = fixture();
    request.mockRejectedValueOnce(new BpmApiError('Session expired', 401));
    await expect(
      runWithAuth(auth('expired'), () => saveDownload(services, 'file', Buffer.from('x')))
    ).rejects.toMatchObject({ httpStatus: 401 });
    await expect(stat(join(root, tenantStorageScope(config)))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a configured exchange root symlink to the filesystem root', async () => {
    const { services, request } = fixture();
    const link = join(root, 'filesystem-root');
    await symlink('/', link);
    services.config.file_root = link;
    await expect(
      runWithAuth(auth('alice'), () => saveDownload(services, 'file', Buffer.from('x')))
    ).rejects.toMatchObject({ httpStatus: 400 });
    expect(request).not.toHaveBeenCalled();
  });

  it('atomically permits one concurrent save and never overwrites it', async () => {
    const { services, request, path } = fixture();
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) =>
        runWithAuth(auth('alice'), () => saveDownload(services, 'race.bin', Buffer.from(String(index))))
      )
    );
    const winner = results.findIndex((result) => result.status === 'fulfilled');
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    for (const result of results)
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ httpStatus: 409 });
    expect((await readFile(path(ALICE, 'race.bin'))).toString()).toBe(String(winner));
    expect(request).toHaveBeenCalledOnce();
  });

  it('preserves trusted local stdio file access outside the exchange root', async () => {
    const { services, request } = fixture();
    const target = join(outside, 'local.txt');
    await saveDownload(services, target, Buffer.from('local'));
    expect(await uploadPath(services, target)).toBe(target);
    expect((await readFile(target)).toString()).toBe('local');
    expect(request).not.toHaveBeenCalled();
  });
});

describe('bounded verified-identity cache', () => {
  it('singleflights each auth scope while isolating more than 500 concurrent users', async () => {
    const { currentUser, request } = fixture();
    const users = await Promise.all(
      Array.from({ length: 550 }, (_, index) =>
        runWithAuth(auth(`user-${index}`), () => Promise.all([currentUser.get(), currentUser.get()]))
      )
    );
    expect(request).toHaveBeenCalledTimes(550);
    expect(new Set(users.map(([first]) => first.userId)).size).toBe(550);
    for (const [first, second] of users) expect(second).toBe(first);
  });

  it('evicts least recently used identities at 2000 entries', async () => {
    const { currentUser, request } = fixture();
    for (let index = 0; index < 2000; index++)
      await runWithAuth(auth(`user-${index}`), () => currentUser.get());
    await runWithAuth(auth('user-0'), () => currentUser.get());
    await runWithAuth(auth('user-2000'), () => currentUser.get());
    await runWithAuth(auth('user-0'), () => currentUser.get());
    expect(request).toHaveBeenCalledTimes(2001);
    await runWithAuth(auth('user-1'), () => currentUser.get());
    expect(request).toHaveBeenCalledTimes(2002);
  });

  it('removes expired identities and re-verifies instead of reusing expired auth', async () => {
    const { currentUser, request } = fixture('ttl', 'https://bpm.example', 1);
    let now = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await runWithAuth(auth('alice'), () => currentUser.get());
    now += 1000;
    await runWithAuth(auth('bob'), () => currentUser.get());
    request.mockRejectedValueOnce(new BpmApiError('Session expired', 401));
    await expect(runWithAuth(auth('alice'), () => currentUser.get())).rejects.toMatchObject({
      httpStatus: 401,
    });
    await runWithAuth(auth('alice'), () => currentUser.get());
    expect(request).toHaveBeenCalledTimes(4);
  });

  it('does not repopulate a cleared cache with a pending old verification', async () => {
    const { currentUser, request } = fixture();
    let complete!: (value: Awaited<ReturnType<typeof request>>) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    );
    const pending = runWithAuth(auth('alice'), () => currentUser.get());
    currentUser.clearCache();
    complete({ status: 200, data: { rows: [{ Id: ALICE, Name: 'alice' }], success: true } });
    await pending;
    await runWithAuth(auth('alice'), () => currentUser.get());
    expect(request).toHaveBeenCalledTimes(2);
  });
});
