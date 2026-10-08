import { describe, expect, it, vi } from 'vitest';
import { runWithAuth } from '../../src/auth/request-context.js';
import { creationRecordIdWithScope } from '../../src/utils/write-safety.js';
import type { ServiceContainer } from '../../src/tools/init-tool.js';

const USER_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const USER_B = 'aaaaaaaa-0000-0000-0000-000000000002';

function services(userId: string) {
  return {
    config: { bpmsoft_url: 'https://crm.example.test/root/', odata_version: 4 },
    currentUser: { get: vi.fn(async () => ({ userId, userName: 'ignored-config-name' })) },
  } as unknown as ServiceContainer;
}

function auth(tenantId: string, session: string) {
  return { tenantId, cookies: new Map([['.ASPXAUTH', session]]) };
}

describe('user-scoped create identities', () => {
  it('replays the same key for the same verified user across sessions', async () => {
    const container = services(USER_A);
    const data = { Name: 'Same request' };
    const first = await runWithAuth(auth('tenant-a', 'session-one'), () =>
      creationRecordIdWithScope(container, data, 'create-1', 'Account:create', 'user')
    );
    const second = await runWithAuth(auth('tenant-a', 'session-two'), () =>
      creationRecordIdWithScope(container, data, 'create-1', 'Account:create', 'user')
    );
    expect(second).toBe(first);
  });

  it('isolates the identity by verified user and tenant', async () => {
    const data = { Name: 'Same request' };
    const first = await runWithAuth(auth('tenant-a', 'one'), () =>
      creationRecordIdWithScope(services(USER_A), data, 'create-1', 'Account:create', 'user')
    );
    const anotherUser = await runWithAuth(auth('tenant-a', 'two'), () =>
      creationRecordIdWithScope(services(USER_B), data, 'create-1', 'Account:create', 'user')
    );
    const anotherTenant = await runWithAuth(auth('tenant-b', 'three'), () =>
      creationRecordIdWithScope(services(USER_A), data, 'create-1', 'Account:create', 'user')
    );
    expect(anotherUser).not.toBe(first);
    expect(anotherTenant).not.toBe(first);
  });

  it('fails closed when tenant or verified current user is unavailable', async () => {
    const container = services(USER_A);
    await expect(
      runWithAuth({ cookies: new Map([['.ASPXAUTH', 'session']]) }, () =>
        creationRecordIdWithScope(container, { Name: 'x' }, 'create-1', 'Account:create', 'user')
      )
    ).rejects.toThrow(/tenant/);
    const noIdentity = {
      config: { bpmsoft_url: 'https://crm.example.test/root', odata_version: 4 },
      currentUser: { get: vi.fn().mockRejectedValue(new Error('unavailable')) },
    } as unknown as ServiceContainer;
    await expect(
      runWithAuth(auth('tenant-a', 'session'), () =>
        creationRecordIdWithScope(noIdentity, { Name: 'x' }, 'create-1', 'Account:create', 'user')
      )
    ).rejects.toThrow(/подтвердить пользователя/);
    await expect(
      runWithAuth({ cookies: new Map([['.ASPXAUTH', 'forwarded-session']]) }, () =>
        creationRecordIdWithScope(container, { Name: 'x' }, 'create-1', 'Account:create', 'user')
      )
    ).rejects.toThrow(/tenant/);
  });

  it('supports stdio/env-creds without request context using the configured origin boundary', async () => {
    const container = services(USER_A);
    const first = await creationRecordIdWithScope(
      container,
      { Name: 'x' },
      'create-1',
      'Account:create',
      'user'
    );
    const second = await creationRecordIdWithScope(
      container,
      { Name: 'x' },
      'create-1',
      'Account:create',
      'user'
    );
    expect(second).toBe(first);
  });

  it('retains strong explicit-ID and idempotency-key conflict checks', async () => {
    await expect(
      runWithAuth(auth('tenant-a', 'session'), () =>
        creationRecordIdWithScope(
          services(USER_A),
          { Id: 'aaaaaaaa-0000-0000-0000-000000000099', Name: 'x' },
          'create-1',
          'Account:create',
          'user'
        )
      )
    ).rejects.toThrow(/конфликтует/);
  });
});
