/**
 * Workflow tools — composite scenarios on top of CRUD that cover typical
 * user requests (register a contact + account, set a status, log an
 * activity, unified search) in a single MCP call.
 *
 * All field/collection names are discovered from BPMSoft metadata at runtime;
 * nothing is hard-coded for a particular instance.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServiceContainer } from '../tools/init-tool.js';
import { registerRegisterContactTool } from './register-contact.js';
import { registerLogActivityTool } from './log-activity.js';
import { registerSetStatusTool } from './set-status.js';
import { registerSearchUnifiedTool } from './search-unified.js';

export { findOrCreate } from './find-or-create.js';
export type { FindOrCreateResult } from './find-or-create.js';

export function registerWorkflowTools(server: McpServer, services: ServiceContainer): void {
  registerRegisterContactTool(server, services);
  registerLogActivityTool(server, services);
  registerSetStatusTool(server, services);
  registerSearchUnifiedTool(server, services);
}
