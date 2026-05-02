#!/usr/bin/env node

/**
 * MCP Server for BPMSoft OData
 *
 * Entry point. Supports two initialization modes:
 *
 * 1. Environment variables (headless):
 *    Set BPMSOFT_URL, BPMSOFT_USERNAME, BPMSOFT_PASSWORD before starting.
 *    Server auto-authenticates on first tool call.
 *
 * 2. Interactive (bpm_init):
 *    Start without env vars. Use bpm_init tool to provide credentials.
 *    All other tools will prompt to run bpm_init first.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { tryLoadConfigFromEnv } from './config.js';
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

  if (envConfig) {
    services = initializeServices(envConfig);
    console.error('[Server] Configuration loaded from environment variables');
    console.error(`  Target: ${envConfig.bpmsoft_url}`);
    console.error(`  OData: v${envConfig.odata_version}, Platform: ${envConfig.platform}`);
  } else {
    console.error('[Server] No environment configuration found.');
    console.error('[Server] Use the bpm_init tool to provide connection parameters.');
  }

  const server = new McpServer({
    name: 'mcp-bpmsoft-odata',
    version: '0.2.0',
  });

  registerInitTool(server, services, (newContainer) => {
    services = newContainer;
  });

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

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const total = TOOLS.length;
  const operational = TOOLS.filter((t) => t.category !== 'init').length;
  console.error(`MCP BPMSoft OData Server running on stdio`);
  console.error(`Registered ${total} tools (bpm_init + ${operational} operational)`);
  console.error(`Registered ${PROMPTS.length} prompts, 4 resource templates`);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
