/**
 * Configuration management for BPMSoft MCP Server
 *
 * Supports two modes:
 * 1. Pre-configured via environment variables (headless/CI)
 * 2. Runtime initialization via bpm_init tool (interactive)
 */

import type { BpmConfig, ODataVersion, PlatformType } from './types/index.js';

const DEFAULT_CONFIG: Omit<BpmConfig, 'bpmsoft_url' | 'username' | 'password'> = {
  odata_version: 4,
  platform: 'net8',
  page_size: 5000,
  max_batch_size: 100,
  lookup_cache_ttl: 300,
  request_timeout: 30000,
  max_file_size: 10 * 1024 * 1024, // 10 MB
};

/**
 * Try loading configuration from environment variables.
 * Returns null if required vars are missing (allows runtime init via bpm_init).
 */
export function tryLoadConfigFromEnv(): BpmConfig | null {
  const url = process.env.BPMSOFT_URL;
  const username = process.env.BPMSOFT_USERNAME;
  const password = process.env.BPMSOFT_PASSWORD;

  if (!url || !username || !password) {
    return null;
  }

  return buildConfig(url, username, password, {
    odata_version: process.env.BPMSOFT_ODATA_VERSION,
    platform: process.env.BPMSOFT_PLATFORM,
  });
}

/**
 * Build a BpmConfig from explicit parameters.
 * Used both by env-loading and by bpm_init tool.
 */
export function buildConfig(
  url: string,
  username: string,
  password: string,
  options?: {
    odata_version?: string | number;
    platform?: string;
  }
): BpmConfig {
  const odataVersion = parseODataVersion(
    typeof options?.odata_version === 'number'
      ? String(options.odata_version)
      : options?.odata_version
  );
  const platform = parsePlatform(options?.platform);

  if (odataVersion === 3 && platform === 'net8') {
    throw new Error('OData 3 поддерживается только на платформе .NET Framework');
  }

  return {
    bpmsoft_url: url.replace(/\/+$/, ''), // strip trailing slashes
    username,
    password,
    odata_version: odataVersion,
    platform,
    page_size: parseIntEnv('BPMSOFT_PAGE_SIZE', DEFAULT_CONFIG.page_size),
    max_batch_size: parseIntEnv('BPMSOFT_MAX_BATCH_SIZE', DEFAULT_CONFIG.max_batch_size),
    lookup_cache_ttl: parseIntEnv('BPMSOFT_LOOKUP_CACHE_TTL', DEFAULT_CONFIG.lookup_cache_ttl),
    request_timeout: parseIntEnv('BPMSOFT_REQUEST_TIMEOUT', DEFAULT_CONFIG.request_timeout),
    max_file_size: parseIntEnv('BPMSOFT_MAX_FILE_SIZE', DEFAULT_CONFIG.max_file_size),
  };
}

/**
 * Derive the OData base URL from config.
 *
 * OData 4 + .NET 8       → {url}/odata
 * OData 4 + .NET Framework → {url}/0/odata
 * OData 3 + .NET Framework → {url}/0/ServiceModel/EntityDataService.svc
 */
export function getODataBaseUrl(config: BpmConfig): string {
  const { bpmsoft_url, odata_version, platform } = config;

  if (odata_version === 4) {
    return platform === 'net8'
      ? `${bpmsoft_url}/odata`
      : `${bpmsoft_url}/0/odata`;
  }

  // OData 3 — only .NET Framework
  return `${bpmsoft_url}/0/ServiceModel/EntityDataService.svc`;
}

/**
 * Get authentication service URL
 */
export function getAuthUrl(config: BpmConfig): string {
  return `${config.bpmsoft_url}/ServiceModel/AuthService.svc/Login`;
}

function parseODataVersion(value: string | undefined): ODataVersion {
  if (!value) return DEFAULT_CONFIG.odata_version;
  const num = parseInt(value, 10);
  if (num === 3 || num === 4) return num;
  throw new Error(`Неверная версия OData: "${value}". Допустимые значения: 3 или 4.`);
}

function parsePlatform(value: string | undefined): PlatformType {
  if (!value) return DEFAULT_CONFIG.platform;
  if (value === 'net8' || value === 'netframework') return value;
  throw new Error(`Неверная платформа: "${value}". Допустимые значения: "net8" или "netframework".`);
}

function parseIntEnv(name: string, defaultValue: number): number {
  const value = process.env[name];
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed <= 0) {
    throw new Error(`Неверное значение ${name}: "${value}". Ожидается положительное целое число.`);
  }
  return parsed;
}
