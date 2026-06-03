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

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { startHttpServer } from './server/http-transport.js';
import { tryLoadConfigFromEnv, isEnvCredsAllowed } from './config.js';
import {
  registerInitTool,
  initializeServices,
  createEmptyContainer,
  type ServiceContainer,
} from './tools/init-tool.js';
import { registerReadTools } from './tools/read-tools.js';
import { registerWriteTools } from './tools/write-tools.js';
import { registerSchemaTools } from './tools/schema-tools.js';
import { registerDescribeInstanceTool } from './tools/describe-instance-tool.js';
import { registerEnumTool } from './tools/enum-tool.js';
import { registerWorkflowCatalogTool } from './tools/workflow-catalog-tool.js';
import { registerBatchTools } from './tools/batch-tools.js';
import { registerStreamTools } from './tools/stream-tools.js';
import { registerProcessTools } from './tools/process-tools.js';
import { registerWorkflowTools } from './workflows/index.js';
import { registerPrompts } from './prompts/index.js';
import { registerResources } from './resources/index.js';
import { TOOLS } from './tools/registry.js';
import { PROMPTS } from './prompts/registry.js';

let services: ServiceContainer = createEmptyContainer();

async function main(): Promise<void> {
  const envConfig = tryLoadConfigFromEnv();

  if (!envConfig) {
    console.error('[Server] FATAL: BPMSOFT_URL is required but not set.');
    console.error('[Server] Set BPMSOFT_URL to the target BPMSoft instance and restart.');
    process.exit(1);
  }

  const allowEnvCreds = isEnvCredsAllowed();
  services = initializeServices(envConfig, allowEnvCreds);
  console.error('[Server] Configuration loaded from environment.');
  console.error(`  Target: ${envConfig.bpmsoft_url}`);
  console.error(`  OData: v${envConfig.odata_version}, Platform: ${envConfig.platform}`);
  console.error(
    `  Auth mode: ${allowEnvCreds ? 'env-creds opt-in (bpm_init available)' : 'per-request (caller forwards credentials)'}`
  );

  // Build a fully-registered McpServer. The HTTP path calls this once per
  // request (see http-transport.ts) so concurrent callers each get their own
  // server/transport; the stdio path calls it once. `services` is shared across
  // all instances — it holds the HttpClient/AuthManager which read per-request
  // auth from AsyncLocalStorage and are stateless w.r.t. user identity.
  const buildServer = (): McpServer => {
    const server = new McpServer({
      name: 'mcp-bpmsoft-odata',
      version: '0.3.0',
    });

    // bpm_init is only exposed when env-stored credentials are explicitly enabled.
    if (allowEnvCreds) {
      registerInitTool(server, services, (newContainer) => {
        services = newContainer;
      });
    }

    registerReadTools(server, services);
    registerWriteTools(server, services);
    registerSchemaTools(server, services);
    registerDescribeInstanceTool(server, services);
    registerEnumTool(server, services);
    registerWorkflowCatalogTool(server, services);
    registerBatchTools(server, services);
    registerStreamTools(server, services);
    registerWorkflowTools(server, services);
    registerProcessTools(server, services);
    registerPrompts(server, services);
    registerResources(server, services);

    return server;
  };

  const operational = TOOLS.filter((t) => t.category !== 'init').length;
  const registeredTools = allowEnvCreds ? operational + 1 : operational;
  console.error(
    `Registered ${registeredTools} tools (${operational} operational${allowEnvCreds ? ' + bpm_init' : ''})`
  );
  console.error(`Registered ${PROMPTS.length} prompts, 4 resource templates`);

  const transportKind = (process.env.MCP_TRANSPORT || 'http').toLowerCase();
  if (transportKind === 'stdio') {
    const server = buildServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('MCP BPMSoft OData Server running on stdio');
  } else {
    const port = parseInt(process.env.MCP_HTTP_PORT || '8007', 10);
    await startHttpServer(buildServer, { port });
    console.error('MCP BPMSoft OData Server running on Streamable HTTP');
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
