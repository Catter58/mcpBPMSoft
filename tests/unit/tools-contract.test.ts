/**
 * Contract test: every registered MCP tool declares outputSchema, a rich
 * description and annotations — mcp-builder conventions.
 */

import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { TOOLS } from '../../src/tools/registry.js';
import { createEmptyContainer, registerInitTool } from '../../src/tools/init-tool.js';
import { registerReadTools } from '../../src/tools/read-tools.js';
import { registerWriteTools } from '../../src/tools/write-tools.js';
import { registerSchemaTools } from '../../src/tools/schema-tools.js';
import { registerBatchTools } from '../../src/tools/batch-tools.js';
import { registerStreamTools } from '../../src/tools/stream-tools.js';
import { registerEnumTool } from '../../src/tools/enum-tool.js';
import { registerDescribeInstanceTool } from '../../src/tools/describe-instance-tool.js';
import { registerWorkflowCatalogTool } from '../../src/tools/workflow-catalog-tool.js';
import { registerProcessTools } from '../../src/tools/process-tools.js';
import { registerRegisterContactTool } from '../../src/workflows/register-contact.js';
import { registerLogActivityTool } from '../../src/workflows/log-activity.js';
import { registerSetStatusTool } from '../../src/workflows/set-status.js';
import { registerSearchUnifiedTool } from '../../src/workflows/search-unified.js';

async function listAllTools() {
  const server = new McpServer({ name: 'contract-test', version: '0.0.0' });
  const container = createEmptyContainer();
  registerInitTool(server, container, () => {});
  registerReadTools(server, container);
  registerWriteTools(server, container);
  registerSchemaTools(server, container);
  registerBatchTools(server, container);
  registerStreamTools(server, container);
  registerEnumTool(server, container);
  registerDescribeInstanceTool(server, container);
  registerWorkflowCatalogTool(server, container);
  registerProcessTools(server, container);
  registerRegisterContactTool(server, container);
  registerLogActivityTool(server, container);
  registerSetStatusTool(server, container);
  registerSearchUnifiedTool(server, container);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'contract-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

describe('tool contract (mcp-builder conventions)', () => {
  it('все инструменты из реестра зарегистрированы, каждый с outputSchema/description/annotations', async () => {
    const tools = await listAllTools();
    expect(tools.length).toBe(TOOLS.length);

    const registryNames = new Set(TOOLS.map((t) => t.name));
    for (const tool of tools) {
      expect(registryNames.has(tool.name), `${tool.name} отсутствует в реестре`).toBe(true);
      expect(tool.outputSchema, `${tool.name}: нет outputSchema`).toBeDefined();
      expect(tool.description ?? '', `${tool.name}: слишком короткое описание`).toMatch(/.{100,}/s);
      expect(tool.annotations, `${tool.name}: нет annotations`).toBeDefined();
      expect(tool.description ?? '', `${tool.name}: в описании нет примера вызова`).toContain('{');
    }
  });

  it('списочные инструменты декларируют has_more в outputSchema', async () => {
    const tools = await listAllTools();
    const listTools = [
      'bpm_get_records',
      'bpm_search_records',
      'bpm_search_unified',
      'bpm_get_collections',
      'bpm_get_enum_values',
      'bpm_find_field',
    ];
    for (const name of listTools) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      const props = (tool!.outputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      expect(Object.keys(props), `${name}: нет has_more`).toContain('has_more');
      expect(Object.keys(props), `${name}: нет count`).toContain('count');
    }
  });
});
