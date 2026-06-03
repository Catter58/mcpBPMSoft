import { describe, it, expect, afterEach } from 'vitest';
import { buildConfig, getODataBaseUrl, getAuthUrl, tryLoadConfigFromEnv, isEnvCredsAllowed } from '../../src/config.js';
import type { BpmConfig } from '../../src/types/index.js';

describe('buildConfig', () => {
  it('applies defaults: odata_version=4, platform=net8', () => {
    const cfg = buildConfig('https://bpm.test', 'u', 'p');
    expect(cfg.odata_version).toBe(4);
    expect(cfg.platform).toBe('net8');
    expect(cfg.bpmsoft_url).toBe('https://bpm.test');
    expect(cfg.username).toBe('u');
    expect(cfg.password).toBe('p');
  });

  it('normalizes URL with trailing slash', () => {
    const cfg = buildConfig('https://bpm.test/', 'u', 'p');
    expect(cfg.bpmsoft_url).toBe('https://bpm.test');
  });

  it('strips multiple trailing slashes', () => {
    const cfg = buildConfig('https://bpm.test///', 'u', 'p');
    expect(cfg.bpmsoft_url).toBe('https://bpm.test');
  });

  it('throws when v3 combined with net8', () => {
    expect(() =>
      buildConfig('https://bpm.test', 'u', 'p', { odata_version: 3, platform: 'net8' })
    ).toThrow();
  });

  it('accepts v3 + netframework', () => {
    const cfg = buildConfig('https://bpm.test', 'u', 'p', {
      odata_version: 3,
      platform: 'netframework',
    });
    expect(cfg.odata_version).toBe(3);
    expect(cfg.platform).toBe('netframework');
  });
});

function makeCfg(overrides: Partial<BpmConfig> = {}): BpmConfig {
  return {
    bpmsoft_url: 'https://bpm.test',
    username: 'u',
    password: 'p',
    odata_version: 4,
    platform: 'net8',
    page_size: 100,
    max_batch_size: 100,
    lookup_cache_ttl: 300,
    request_timeout: 30000,
    max_file_size: 10 * 1024 * 1024,
    ...overrides,
  };
}

describe('getODataBaseUrl', () => {
  it('net8 + v4 -> {url}/odata', () => {
    expect(getODataBaseUrl(makeCfg())).toBe('https://bpm.test/odata');
  });

  it('netframework + v4 -> {url}/0/odata', () => {
    expect(getODataBaseUrl(makeCfg({ platform: 'netframework' }))).toBe(
      'https://bpm.test/0/odata'
    );
  });

  it('netframework + v3 -> {url}/0/ServiceModel/EntityDataService.svc', () => {
    expect(
      getODataBaseUrl(makeCfg({ odata_version: 3, platform: 'netframework' }))
    ).toBe('https://bpm.test/0/ServiceModel/EntityDataService.svc');
  });
});

describe('getAuthUrl', () => {
  it('always points to /ServiceModel/AuthService.svc/Login on net8', () => {
    expect(getAuthUrl(makeCfg())).toBe(
      'https://bpm.test/ServiceModel/AuthService.svc/Login'
    );
  });

  it('uses the same path on netframework (per official Postman)', () => {
    expect(getAuthUrl(makeCfg({ platform: 'netframework' }))).toBe(
      'https://bpm.test/ServiceModel/AuthService.svc/Login'
    );
  });

  it('uses the same path on v3', () => {
    expect(
      getAuthUrl(makeCfg({ odata_version: 3, platform: 'netframework' }))
    ).toBe('https://bpm.test/ServiceModel/AuthService.svc/Login');
  });
});

describe('buildConfig without credentials', () => {
  it('builds a config when username/password are omitted', () => {
    const cfg = buildConfig('https://bpm.test');
    expect(cfg.bpmsoft_url).toBe('https://bpm.test');
    expect(cfg.username).toBeUndefined();
    expect(cfg.password).toBeUndefined();
    expect(cfg.odata_version).toBe(4);
  });
});

describe('tryLoadConfigFromEnv', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('requires only BPMSOFT_URL', () => {
    process.env = { ...saved, BPMSOFT_URL: 'https://bpm.test' };
    delete process.env.BPMSOFT_USERNAME;
    delete process.env.BPMSOFT_PASSWORD;
    delete process.env.BPMSOFT_ALLOW_ENV_CREDS;
    const cfg = tryLoadConfigFromEnv();
    expect(cfg).not.toBeNull();
    expect(cfg!.bpmsoft_url).toBe('https://bpm.test');
    expect(cfg!.username).toBeUndefined();
  });

  it('returns null when BPMSOFT_URL missing', () => {
    process.env = { ...saved };
    delete process.env.BPMSOFT_URL;
    expect(tryLoadConfigFromEnv()).toBeNull();
  });

  it('ignores credentials when env-creds opt-in is off', () => {
    process.env = {
      ...saved,
      BPMSOFT_URL: 'https://bpm.test',
      BPMSOFT_USERNAME: 'u',
      BPMSOFT_PASSWORD: 'p',
      BPMSOFT_ALLOW_ENV_CREDS: 'false',
    };
    const cfg = tryLoadConfigFromEnv();
    expect(cfg!.username).toBeUndefined();
    expect(cfg!.password).toBeUndefined();
  });

  it('loads credentials when opt-in is on', () => {
    process.env = {
      ...saved,
      BPMSOFT_URL: 'https://bpm.test',
      BPMSOFT_USERNAME: 'u',
      BPMSOFT_PASSWORD: 'p',
      BPMSOFT_ALLOW_ENV_CREDS: 'true',
    };
    expect(isEnvCredsAllowed()).toBe(true);
    const cfg = tryLoadConfigFromEnv();
    expect(cfg!.username).toBe('u');
    expect(cfg!.password).toBe('p');
  });
});
