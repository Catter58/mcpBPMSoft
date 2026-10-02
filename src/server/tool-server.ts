import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SERVER_VERSION } from '../version.js';
import { registerInitTool, type ServiceContainer } from '../tools/init-tool.js';
import { registerReadTools } from '../tools/read-tools.js';
import { registerWriteTools } from '../tools/write-tools.js';
import { registerSchemaTools } from '../tools/schema-tools.js';
import { registerDescribeInstanceTool } from '../tools/describe-instance-tool.js';
import { registerEnumTool } from '../tools/enum-tool.js';
import { registerWorkflowCatalogTool } from '../tools/workflow-catalog-tool.js';
import { registerBatchTools } from '../tools/batch-tools.js';
import { registerStreamTools } from '../tools/stream-tools.js';
import { registerProcessTools } from '../tools/process-tools.js';
import { registerWorkflowTools } from '../workflows/index.js';
import { registerPrompts } from '../prompts/index.js';
import { registerResources } from '../resources/index.js';
import { instrumentTools } from './instrumentation.js';
import { registerAggregateTool } from '../tools/aggregate-tool.js';
import { registerRecordCardTool } from '../tools/record-card-tool.js';
import { registerRelationsTool } from '../tools/relations-tool.js';
import { registerDedupTools } from '../tools/dedup-tools.js';
import { registerWhoamiTool } from '../tools/whoami-tool.js';

/** Production and integration tests use exactly the same tool registration. */
export function createToolServer(
  services: ServiceContainer,
  options: { allowEnvCreds?: boolean; onInitialized?: (services: ServiceContainer) => void } = {}
): McpServer {
  const server = new McpServer({ name: 'mcp-bpmsoft-odata', version: SERVER_VERSION });
  instrumentTools(server);
  if (options.allowEnvCreds) {
    registerInitTool(server, services, (replacement) => {
      Object.assign(services, replacement);
      options.onInitialized?.(services);
    });
  }
  registerReadTools(server, services);
  registerWriteTools(server, services);
  registerSchemaTools(server, services);
  registerDescribeInstanceTool(server, services);
  registerEnumTool(server, services);
  registerAggregateTool(server, services);
  registerRecordCardTool(server, services);
  registerRelationsTool(server, services);
  registerDedupTools(server, services);
  registerWhoamiTool(server, services);
  registerWorkflowCatalogTool(server, services);
  registerBatchTools(server, services);
  registerStreamTools(server, services);
  registerWorkflowTools(server, services);
  registerProcessTools(server, services);
  registerPrompts(server, services);
  registerResources(server, services);
  return server;
}
