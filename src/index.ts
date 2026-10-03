#!/usr/bin/env node

/**
 * MCP Server for BPMSoft OData
 *
 * Entry point. Per-request auth model:
 *
 * - Only BPMSOFT_URL is required (fatal exit if missing); it pins the target
 *   instance. Credentials are NOT stored server-side.
 * - Each request carries the caller's auth (BPMCSRF + cookies) over the
 *   Streamable HTTP transport; tools forward it to BPMSoft per-request.
 * - Env-stored credentials are an opt-in fallback: set BPMSOFT_ALLOW_ENV_CREDS
 *   to expose the hidden bpm_init tool and allow login from
 *   BPMSOFT_USERNAME / BPMSOFT_PASSWORD. Off by default.
 *
 * Transport: chosen via MCP_TRANSPORT (default `http`; set `stdio` for stdio).
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { startHttpServer } from './server/http-transport.js';
import { isEnvCredsAllowed, loadLocalEnvironment } from './config.js';
import { loadTenantRegistry } from './server/tenant-registry.js';
import { createToolServer } from './server/tool-server.js';
import { TOOLS } from './tools/registry.js';
import { PROMPTS } from './prompts/registry.js';

async function main(): Promise<void> {
  loadLocalEnvironment();
  const registry = loadTenantRegistry();
  const allowEnvCreds = isEnvCredsAllowed();
  console.error(`[Server] Configuration loaded (${registry.multitenant ? 'multitenant' : 'single stand'}).`);
  console.error(
    `  Auth mode: ${allowEnvCreds ? 'env-creds opt-in (bpm_init available)' : 'per-request (caller forwards credentials)'}`
  );

  // Build a fully-registered McpServer. The HTTP path calls this once per
  // request (see http-transport.ts) so concurrent callers each get their own
  // server/transport; the stdio path calls it once. Each tenant owns its services;
  // auth and cancellation remain bound to each request via AsyncLocalStorage.
  const buildServer = (tenant: string) => createToolServer(registry.get(tenant), { allowEnvCreds });

  const operational = TOOLS.filter(
    (t) =>
      t.category !== 'init' &&
      (t.name !== 'bpm_get_operation' || registry.multitenant || !!process.env.BPMSOFT_JOURNAL_ROOT)
  ).length;
  const registeredTools = allowEnvCreds ? operational + 1 : operational;
  console.error(
    `Registered ${registeredTools} tools (${operational} operational${allowEnvCreds ? ' + bpm_init' : ''})`
  );
  console.error(`Registered ${PROMPTS.length} prompts, 1 resource and 3 resource templates`);

  const transportKind = (process.env.MCP_TRANSPORT || 'http').toLowerCase();
  if (!['http', 'stdio'].includes(transportKind))
    throw new Error('MCP_TRANSPORT должен быть http или stdio.');
  if (transportKind === 'stdio') {
    if (registry.multitenant) throw new Error('Мультитенантный режим доступен только через HTTP.');
    if (!allowEnvCreds)
      throw new Error(
        'stdio не передаёт HTTP cookies. Включите BPMSOFT_ALLOW_ENV_CREDS=true и задайте данные отдельного пользователя для локального подключения.'
      );
    const server = buildServer('default');
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('MCP BPMSoft OData Server running on stdio');
  } else {
    const rawPort = process.env.MCP_HTTP_PORT || '8007';
    const port = /^\d+$/.test(rawPort) ? Number(rawPort) : NaN;
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error('MCP_HTTP_PORT должен быть числом от 1 до 65535.');
    const host = process.env.MCP_HTTP_HOST || '127.0.0.1';
    if (allowEnvCreds && !['127.0.0.1', 'localhost', '::1'].includes(host)) {
      throw new Error(
        'env-creds HTTP допускается только на loopback интерфейсе. Для удалённых пользователей используйте per-request авторизацию.'
      );
    }
    const limit = (name: string, fallback: number) => {
      const raw = process.env[name];
      const value = raw === undefined ? fallback : /^\d+$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name}: нужно положительное целое.`);
      return value;
    };
    const httpServer = await startHttpServer((req) => buildServer(registry.resolveTenant(req)), {
      port,
      host,
      resolveTenant: (req) => registry.resolveTenant(req),
      requireAuth: registry.multitenant,
      maxConcurrentRequests: limit('MCP_MAX_CONCURRENT_REQUESTS', 500),
      maxQueuedRequests: limit('MCP_MAX_QUEUED_REQUESTS', 500),
      maxConcurrentPerScope: limit('MCP_MAX_CONCURRENT_PER_SCOPE', 50),
      allowedHosts: process.env.MCP_ALLOWED_HOSTS?.split(',')
        .map((item) => item.trim())
        .filter(Boolean),
      allowedOrigins: process.env.MCP_ALLOWED_ORIGINS?.split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    });
    const shutdown = () => {
      httpServer.close();
      const force = setTimeout(() => {
        httpServer.closeAllConnections();
      }, 10000);
      force.unref();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    console.error(`MCP BPMSoft OData Server running on Streamable HTTP (${host}:${port})`);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
