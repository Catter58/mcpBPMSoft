import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTenantRegistry, TenantRegistry } from '../../src/server/tenant-registry.js';
import { buildConfig } from '../../src/config.js';
import { runWithAuth, getAuthCacheScope } from '../../src/auth/request-context.js';
import { createConfirmationPlan, consumeConfirmationPlan, operationScope } from '../../src/utils/confirm.js';
import { encodeCursor, decodeCursor } from '../../src/utils/cursor.js';
import {
  isTolowerSupported,
  markTolowerUnsupported,
  resetServerCapabilities,
} from '../../src/utils/server-capabilities.js';

let folder: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  resetServerCapabilities();
  if (folder) await rm(folder, { recursive: true, force: true });
  folder = undefined;
});

async function configure() {
  folder = await mkdtemp(join(tmpdir(), 'bpm-tenants-'));
  const path = join(folder, 'tenants.json');
  await writeFile(
    path,
    JSON.stringify({
      tenants: [
        { id: 'east', url: 'https://east.example', odata_version: 4, platform: 'net8' },
        { id: 'west', url: 'https://west.example', odata_version: 3, platform: 'netframework' },
      ],
    })
  );
  vi.stubEnv('BPMSOFT_TENANTS_FILE', path);
  vi.stubEnv('BPMSOFT_ALLOW_ENV_CREDS', 'false');
}

describe('operator tenant allowlist and legacy startup', () => {
  it('ignores the tenants file unless the explicit flag is enabled', async () => {
    await configure();
    for (const flag of [undefined, '', 'false', '0']) {
      vi.stubEnv('BPMSOFT_MULTITENANT', flag);
      vi.stubEnv('BPMSOFT_URL', 'https://single.example');
      const registry = loadTenantRegistry();
      expect(registry.multitenant).toBe(false);
      expect(registry.get('default').config.bpmsoft_url).toBe('https://single.example');
      expect(registry.resolveTenant({ url: '/mcp' })).toBe('default');
      expect(registry.resolveTenant({ url: '/' })).toBe('default');
      expect(() => registry.resolveTenant({ url: '/tenants/east/mcp' })).toThrow();
      expect(() => registry.resolveTenant({ url: '/tenants/default/mcp' })).toThrow();
    }
  });
  it('does not read a missing tenant configuration when the flag is absent', () => {
    vi.stubEnv('BPMSOFT_MULTITENANT', undefined);
    vi.stubEnv('BPMSOFT_TENANTS_FILE', '/nonexistent/tenants.json');
    vi.stubEnv('BPMSOFT_URL', 'https://single.example');
    expect(loadTenantRegistry().get('default').config.bpmsoft_url).toBe('https://single.example');
  });
  it('requires the original URL in legacy mode even when a tenants file exists', async () => {
    await configure();
    vi.stubEnv('BPMSOFT_MULTITENANT', 'false');
    vi.stubEnv('BPMSOFT_URL', '');
    expect(() => loadTenantRegistry()).toThrow('BPMSOFT_URL');
  });
  it('pins distinct services and protocol settings only with explicit opt-in', async () => {
    await configure();
    vi.stubEnv('BPMSOFT_MULTITENANT', 'true');
    const registry = loadTenantRegistry();
    expect(registry.resolveTenant({ url: '/tenants/east/mcp' })).toBe('east');
    expect(registry.get('east').httpClient).not.toBe(registry.get('west').httpClient);
    expect(registry.get('west').config.odata_version).toBe(3);
    expect(registry.get('east').config.username).toBeUndefined();
    for (const url of [
      '/mcp',
      '/',
      '/tenants/unknown/mcp',
      '/tenants/east/mcp?url=https://evil.example',
      '/tenants/east%2fwest/mcp',
    ])
      expect(() => registry.resolveTenant({ url })).toThrow();
  });
  it('fails closed for missing config, shared credentials, duplicate ids or arbitrary URL fields', async () => {
    vi.stubEnv('BPMSOFT_MULTITENANT', 'true');
    vi.stubEnv('BPMSOFT_TENANTS_FILE', '');
    expect(() => loadTenantRegistry()).toThrow('BPMSOFT_TENANTS_FILE');
    await configure();
    vi.stubEnv('BPMSOFT_ALLOW_ENV_CREDS', 'true');
    expect(() => loadTenantRegistry()).toThrow('BPMSOFT_ALLOW_ENV_CREDS');
    vi.stubEnv('BPMSOFT_ALLOW_ENV_CREDS', 'false');
    await writeFile(
      process.env.BPMSOFT_TENANTS_FILE!,
      JSON.stringify({
        tenants: [
          { id: 'a', url: 'https://a.example' },
          { id: 'a', url: 'https://b.example' },
        ],
      })
    );
    expect(() => loadTenantRegistry()).toThrow('уникальны');
    await writeFile(
      process.env.BPMSOFT_TENANTS_FILE!,
      JSON.stringify({ tenants: [{ id: 'a', url: 'file:///etc/passwd' }] })
    );
    expect(() => loadTenantRegistry()).toThrow();
  });
});

describe('cross-tenant session state cannot be reused', () => {
  it('separates capabilities, confirmations and cursors with identical cookies', () => {
    const registry = new TenantRegistry(
      ['a', 'b'].map((id) => ({
        id,
        config: {
          ...buildConfig(`https://${id}.example`),
          tenant_id: id,
        },
      })),
      true
    );
    const auth = (tenantId: string) => ({
      tenantId,
      csrfToken: 'same',
      cookies: new Map([['.ASPXAUTH', 'same']]),
    });
    const first = registry.get('a');
    const second = registry.get('b');
    const operation = { delete: ['id'] };
    const state = { v: 1 as const, collection: 'Contact', skip: 20 };
    const saved = runWithAuth(auth('a'), () => {
      markTolowerUnsupported();
      return {
        scope: getAuthCacheScope(),
        token: createConfirmationPlan(first, operation),
        cursor: encodeCursor(state, operationScope(first)),
      };
    });
    runWithAuth(auth('b'), () => {
      expect(getAuthCacheScope()).not.toBe(saved.scope);
      expect(isTolowerSupported()).toBe(true);
      expect(() => consumeConfirmationPlan(second, saved.token, operation)).toThrow();
      expect(() => decodeCursor(saved.cursor, operationScope(second))).toThrow();
      expect(() => consumeConfirmationPlan(first, saved.token, operation)).toThrow();
    });
    runWithAuth(auth('a'), () => {
      expect(isTolowerSupported()).toBe(false);
      expect(decodeCursor(saved.cursor, operationScope(first))).toEqual(state);
      consumeConfirmationPlan(first, saved.token, operation);
    });
  });
});

describe('confirmation freshness conflicts', () => {
  it('returns changed fields for the same intent and exact target set', () => {
    const registry = new TenantRegistry(
      [{ id: 'fresh', config: buildConfig('https://fresh.example') }],
      true
    );
    const services = registry.get('fresh');
    const intent = { updates: [{ id: 'record-1', data: { Score: 4 } }] };
    const before = { index: 0, id: 'record-1', values: { Score: 3, Name: 'Before' } };
    const token = createConfirmationPlan(services, { plan: 1 }, { intent, snapshots: [before] });
    const result = consumeConfirmationPlan(
      services,
      token,
      { plan: 2 },
      {
        intent,
        snapshots: [{ index: 0, id: 'record-1', values: { Score: 3, Name: 'After', OwnerId: undefined } }],
      }
    );
    expect(result?.changed).toEqual([
      {
        index: 0,
        id: 'record-1',
        fields: [
          { field: 'Name', before: 'Before', current: 'After' },
          { field: 'OwnerId', before: undefined, current: undefined },
        ],
      },
    ]);
  });

  it('does not refresh a changed intent or retargeted/removed rows', () => {
    const registry = new TenantRegistry(
      [{ id: 'fresh2', config: buildConfig('https://fresh2.example') }],
      true
    );
    const services = registry.get('fresh2');
    const intent = { updates: [{ id: 'record-1', data: { Score: 4 } }] };
    const snapshot = { index: 0, id: 'record-1', values: { Score: 3 } };
    const token = createConfirmationPlan(services, { plan: 1 }, { intent, snapshots: [snapshot] });
    expect(() =>
      consumeConfirmationPlan(
        services,
        token,
        { plan: 2 },
        {
          intent: { updates: [{ id: 'record-1', data: { Score: 9 } }] },
          snapshots: [snapshot],
        }
      )
    ).toThrow();
    expect(() =>
      consumeConfirmationPlan(
        services,
        token,
        { plan: 2 },
        {
          intent,
          snapshots: [{ index: 0, id: 'different-record', values: { Score: 3 } }],
        }
      )
    ).toThrow();
    expect(() => consumeConfirmationPlan(services, token, { plan: 2 }, { intent, snapshots: [] })).toThrow();
  });

  it('does not accept a changed relative operation just because it normalizes to the same absolute value', () => {
    const registry = new TenantRegistry(
      [{ id: 'fresh3', config: buildConfig('https://fresh3.example') }],
      true
    );
    const services = registry.get('fresh3');
    const snapshot = { index: 0, id: 'record-1', values: { Score: 5 } };
    const token = createConfirmationPlan(
      services,
      { plan: 1 },
      {
        intent: {
          updates: [{ id: 'record-1', operations: [{ field: 'Score', op: 'increment', amount: 1 }] }],
        },
        acceptedIntents: [{ updates: [{ id: 'record-1', data: { Score: 6 } }] }],
        snapshots: [snapshot],
      }
    );
    expect(() =>
      consumeConfirmationPlan(
        services,
        token,
        { plan: 2 },
        {
          intent: {
            updates: [{ id: 'record-1', operations: [{ field: 'Score', op: 'increment', amount: 2 }] }],
          },
          acceptedIntents: [{ updates: [{ id: 'record-1', data: { Score: 6 } }] }],
          snapshots: [{ index: 0, id: 'record-1', values: { Score: 4 } }],
        }
      )
    ).toThrow();
  });
});
