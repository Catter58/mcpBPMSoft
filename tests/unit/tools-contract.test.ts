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
import { createToolServer } from '../../src/server/tool-server.js';
import { registerReadTools } from '../../src/tools/read-tools.js';
import { registerWriteTools } from '../../src/tools/write-tools.js';
import { registerSchemaTools } from '../../src/tools/schema-tools.js';
import { registerBatchTools } from '../../src/tools/batch-tools.js';
import { registerStreamTools } from '../../src/tools/stream-tools.js';
import { registerEnumTool } from '../../src/tools/enum-tool.js';
import { registerAggregateTool } from '../../src/tools/aggregate-tool.js';
import { registerRecordCardTool } from '../../src/tools/record-card-tool.js';
import { registerRelationsTool } from '../../src/tools/relations-tool.js';
import { registerDedupTools } from '../../src/tools/dedup-tools.js';
import { registerMyAgendaTool } from '../../src/workflows/my-agenda.js';
import { registerWhoamiTool } from '../../src/tools/whoami-tool.js';
import { registerDescribeInstanceTool } from '../../src/tools/describe-instance-tool.js';
import { registerWorkflowCatalogTool } from '../../src/tools/workflow-catalog-tool.js';
import { registerProcessTools } from '../../src/tools/process-tools.js';
import { registerRegisterContactTool } from '../../src/workflows/register-contact.js';
import { registerLogActivityTool } from '../../src/workflows/log-activity.js';
import { registerSetStatusTool } from '../../src/workflows/set-status.js';
import { registerSearchUnifiedTool } from '../../src/workflows/search-unified.js';
import { registerOperationTool } from '../../src/tools/operation-tool.js';

const BASELINE_TOOL_NAMES = [
  'bpm_aggregate',
  'bpm_aggregate_records',
  'bpm_batch_create',
  'bpm_batch_delete',
  'bpm_batch_update',
  'bpm_check_duplicates',
  'bpm_count_records',
  'bpm_create_record',
  'bpm_delete_by_filter',
  'bpm_delete_record',
  'bpm_describe_instance',
  'bpm_download_file',
  'bpm_exec_process_element',
  'bpm_field_delete',
  'bpm_field_download',
  'bpm_field_upload',
  'bpm_find_duplicates',
  'bpm_find_field',
  'bpm_get_collections',
  'bpm_get_enum_values',
  'bpm_get_operation',
  'bpm_get_record',
  'bpm_get_records',
  'bpm_get_relations',
  'bpm_get_schema',
  'bpm_init',
  'bpm_log_activity',
  'bpm_lookup_value',
  'bpm_merge_duplicates',
  'bpm_my_agenda',
  'bpm_post_feed',
  'bpm_record_card',
  'bpm_register_contact',
  'bpm_run_process',
  'bpm_search_records',
  'bpm_search_unified',
  'bpm_set_status',
  'bpm_update_by_filter',
  'bpm_update_record',
  'bpm_upload_file',
  'bpm_whoami',
  'bpm_workflow_catalog',
].sort();

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
  registerAggregateTool(server, container);
  registerRecordCardTool(server, container);
  registerRelationsTool(server, container);
  registerDedupTools(server, container);
  registerMyAgendaTool(server, container);
  registerWhoamiTool(server, container);
  registerDescribeInstanceTool(server, container);
  registerWorkflowCatalogTool(server, container);
  registerProcessTools(server, container);
  registerRegisterContactTool(server, container);
  registerLogActivityTool(server, container);
  registerSetStatusTool(server, container);
  registerSearchUnifiedTool(server, container);
  registerOperationTool(server, container);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'contract-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

async function listRegisteredNames(allowEnvCreds: boolean, journalEnabled: boolean): Promise<string[]> {
  const services = createEmptyContainer();
  if (journalEnabled) services.config = { journal_root: '/tmp/test-journal' } as never;
  const server = createToolServer(services, { allowEnvCreds });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'tool-profile-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const { tools } = await client.listTools();
    return tools.map((tool) => tool.name).sort();
  } finally {
    await client.close();
  }
}

describe('tool contract (mcp-builder conventions)', () => {
  it('preserves the declared tool-name baseline and optional registration profile counts', async () => {
    const declaredNames = TOOLS.map((tool) => tool.name).sort();
    expect(declaredNames).toEqual(BASELINE_TOOL_NAMES);
    expect(declaredNames).toHaveLength(42);
    const profileInputs: Array<[boolean, boolean, number]> = [
      [false, false, 40],
      [false, true, 41],
      [true, false, 41],
      [true, true, 42],
    ];
    for (const [allowEnvCreds, journalEnabled, expectedCount] of profileInputs) {
      const registeredNames = await listRegisteredNames(allowEnvCreds, journalEnabled);
      const expectedNames = declaredNames.filter(
        (name) => (allowEnvCreds || name !== 'bpm_init') && (journalEnabled || name !== 'bpm_get_operation')
      );
      expect(registeredNames).toEqual(expectedNames);
      expect(registeredNames).toHaveLength(expectedCount);
    }
  });

  it('accepts nested boolean criteria through the real MCP client schema', async () => {
    const server = new McpServer({ name: 'nested-criteria-test', version: '0.0.0' });
    const container = createEmptyContainer();
    registerReadTools(server, container);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'nested-criteria-client', version: '0.0.0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const result = await client.callTool({
        name: 'bpm_search_records',
        arguments: {
          collection: 'Contact',
          criteria: [
            {
              or: [
                { field: 'Name', op: 'eq', value: 'Иван' },
                {
                  not: {
                    and: [
                      { field: 'Age', op: 'gt', value: 17 },
                      { field: 'Age', op: 'lt', value: 65 },
                    ],
                  },
                },
              ],
            },
          ],
        },
      });
      expect(result.isError).toBe(true); // the empty container rejects execution after schema validation
      expect(JSON.stringify(result)).toContain('не настроено');
    } finally {
      await client.close();
    }
  });

  it('keeps the serialized read-tool criteria schema compact for MCP clients', async () => {
    const tools = await listAllTools();
    const tool = tools.find((item) => item.name === 'bpm_search_records')!;
    const schemaBytes = Buffer.byteLength(JSON.stringify(tool.inputSchema));
    expect(schemaBytes).toBeLessThan(10_000);
  });

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
