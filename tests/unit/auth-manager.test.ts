import { describe, it, expect, vi } from 'vitest';
import { AuthManager } from '../../src/auth/auth-manager.js';
import { HttpClient } from '../../src/client/http-client.js';
import { AuthRequiredError } from '../../src/utils/errors.js';
import { runWithAuth, extractAuthFromHeaders } from '../../src/auth/request-context.js';
import type { BpmConfig } from '../../src/types/index.js';

function makeCfg(overrides: Partial<BpmConfig> = {}): BpmConfig {
  return {
    bpmsoft_url: 'https://bpm.test',
    odata_version: 4,
    platform: 'net8',
    page_size: 100,
    max_batch_size: 100,
    lookup_cache_ttl: 300,
    request_timeout: 5000,
    max_file_size: 10 * 1024 * 1024,
    ...overrides,
  };
}

describe('AuthManager.ensureAuthenticated', () => {
  it('per-request mode: no-op when ALS auth present, never logs in', async () => {
    const client = new HttpClient(makeCfg());
    const mgr = new AuthManager(makeCfg(), client, false);
    const loginSpy = vi.spyOn(mgr, 'login').mockResolvedValue();

    const auth = extractAuthFromHeaders({ BPMCSRF: 'c', Cookie: 'CsrfToken=t' });
    await runWithAuth(auth, () => mgr.ensureAuthenticated());

    expect(loginSpy).not.toHaveBeenCalled();
  });

  it('no auth + env-creds off -> AuthRequiredError', async () => {
    const client = new HttpClient(makeCfg());
    const mgr = new AuthManager(makeCfg(), client, false);
    await expect(mgr.ensureAuthenticated()).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it('env-creds on + not authenticated -> calls login', async () => {
    const client = new HttpClient(makeCfg({ username: 'u', password: 'p' }));
    const mgr = new AuthManager(makeCfg({ username: 'u', password: 'p' }), client, true);
    const loginSpy = vi.spyOn(mgr, 'login').mockResolvedValue();

    await mgr.ensureAuthenticated();
    expect(loginSpy).toHaveBeenCalledTimes(1);
  });
});
