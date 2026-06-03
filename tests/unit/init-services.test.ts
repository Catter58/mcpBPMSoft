import { describe, it, expect } from 'vitest';
import { initializeServices } from '../../src/tools/init-tool.js';
import type { BpmConfig } from '../../src/types/index.js';

function cfg(): BpmConfig {
  return {
    bpmsoft_url: 'https://bpm.test',
    odata_version: 4,
    platform: 'net8',
    page_size: 100,
    max_batch_size: 100,
    lookup_cache_ttl: 300,
    request_timeout: 5000,
    max_file_size: 10 * 1024 * 1024,
  };
}

describe('initializeServices', () => {
  it('builds a container without credentials and defaults allowEnvCreds=false', () => {
    const c = initializeServices(cfg());
    expect(c.initialized).toBe(true);
    expect(c.httpClient).toBeTruthy();
    expect(c.authManager).toBeTruthy();
  });

  it('accepts allowEnvCreds flag', () => {
    const c = initializeServices(cfg(), true);
    expect(c.initialized).toBe(true);
  });
});
