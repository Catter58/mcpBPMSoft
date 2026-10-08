import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createToolServer, SERVER_INSTRUCTIONS } from '../../src/server/tool-server.js';
import { createEmptyContainer } from '../../src/tools/init-tool.js';
import { TOOLS } from '../../src/tools/registry.js';

const ROUTE_CASES = [
  { intent: 'Нужен общий обзор карточки записи', tool: 'bpm_record_card' },
  { intent: 'Получить одну запись по названию', tool: 'bpm_get_record' },
  { intent: 'Найти набор записей по условиям', tool: 'bpm_search_records' },
  { intent: 'Узнать число подходящих записей', tool: 'bpm_count_records' },
  { intent: 'Посчитать суммы и группировки', tool: 'bpm_aggregate' },
  { intent: 'Найти доступные поля', tool: 'bpm_get_schema' },
  { intent: 'Создать или обновить с lookup по имени', tool: 'bpm_create_record' },
  { intent: 'Создать несколько записей', tool: 'bpm_batch_create' },
  { intent: 'Изменить выбранный список', tool: 'bpm_batch_update' },
  { intent: 'Удалить выбранный список', tool: 'bpm_batch_delete' },
  { intent: 'Изменить много записей', tool: 'bpm_update_by_filter' },
  { intent: 'Удалить несколько записей', tool: 'bpm_delete_by_filter' },
] as const;

const APP_VERSION = /BPMSoft\s+\d+\.\d+|ограничения платформы\s+\d+\.\d+/i;

async function connectServer(config?: {
  max_batch_size: number;
  max_file_size: number;
  odata_version: 3 | 4;
}) {
  const services = createEmptyContainer();
  if (config) services.config = config as never;
  const server = createToolServer(services);
  const client = new Client({ name: 'server-guidance-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

describe('server guidance and workflow catalog', () => {
  it('publishes concise, capability-oriented routing instructions during initialize', async () => {
    const { client } = await connectServer();
    try {
      const instructions = client.getInstructions();
      const { tools } = await client.listTools();
      const instructionBytes = Buffer.byteLength(instructions ?? '', 'utf8');
      const toolListBytes = Buffer.byteLength(JSON.stringify(tools), 'utf8');

      expect(instructions).toBe(SERVER_INSTRUCTIONS);
      expect(instructionBytes).toBeLessThan(1500);
      expect(toolListBytes).toBeGreaterThan(0);
      const toolNames = new Set(tools.map((tool) => tool.name));
      expect(toolNames.has('bpm_workflow_catalog')).toBe(true);
      for (const route of ROUTE_CASES) expect(toolNames.has(route.tool), route.intent).toBe(true);
      expect(TOOLS.map((tool) => tool.name)).toContain('bpm_workflow_catalog');

      const readDescription = TOOLS.find((tool) => tool.name === 'bpm_get_record')?.description ?? '';
      const searchDescription = TOOLS.find((tool) => tool.name === 'bpm_search_unified')?.description ?? '';
      const writeDescription = TOOLS.find((tool) => tool.name === 'bpm_update_record')?.description ?? '';
      const batchDescription = TOOLS.find((tool) => tool.name === 'bpm_batch_update')?.description ?? '';
      const analyticsDescription =
        TOOLS.find((tool) => tool.name === 'bpm_aggregate_records')?.description ?? '';
      expect(readDescription).toMatch(/UUID или однозначному названию/i);
      expect(readDescription).toContain('verify');
      expect(searchDescription).toContain('fields_by_collection');
      expect(searchDescription).toContain('matched_fields');
      expect(searchDescription).toContain('match_mode=exact');
      expect(writeDescription).toContain('argument_patch');
      expect(writeDescription).toContain('verification_args');
      expect(batchDescription).toContain('retry_args');
      expect(analyticsDescription).toContain('rank_by');
      expect(analyticsDescription).toContain('bucket_field');

      for (const route of ROUTE_CASES) {
        expect(instructions, route.intent).toContain(route.tool);
      }
      expect(instructions).toMatch(/неоднозначн/i);
      expect(instructions).toMatch(/явн.*подтверж/i);

      console.info(
        `[server-guidance-measurement] ${JSON.stringify({
          instruction_bytes: instructionBytes,
          tool_count: tools.length,
          tool_list_json_bytes: toolListBytes,
          combined_initialize_guidance_and_tool_list_bytes: instructionBytes + toolListBytes,
          route_cases: ROUTE_CASES.length,
          observed_model_turn_savings: false,
        })}`
      );
    } finally {
      await client.close();
    }
  });

  it('keeps all catalog routes registered and specific guidance version-neutral', async () => {
    const { client } = await connectServer({ max_batch_size: 7, max_file_size: 12345, odata_version: 3 });
    try {
      const { tools } = await client.listTools();
      const toolNames = new Set(tools.map((tool) => tool.name));
      const meta = TOOLS.find((tool) => tool.name === 'bpm_workflow_catalog');
      expect(meta?.description).not.toMatch(APP_VERSION);

      const full = await client.callTool({ name: 'bpm_workflow_catalog', arguments: {} });
      const text = full.content
        .filter((item) => item.type === 'text')
        .map((item) => item.text)
        .join('\n');
      const structured = full.structuredContent as {
        scenarios: Array<{ id: string; recommended_tools: string[]; notes?: string }>;
        limits: string[];
        scope_note: string;
      };
      expect(text).not.toMatch(APP_VERSION);
      expect(JSON.stringify(structured)).not.toMatch(APP_VERSION);
      expect(structured.scope_note).toMatch(/инстанс/i);
      expect(structured.limits.join('\n')).toContain('7 операций');
      expect(structured.limits.join('\n')).toContain('12345 байт');
      expect(structured.limits.join('\n')).toContain('OData v3');
      expect(structured.limits.join('\n')).not.toContain('20 000');

      for (const scenario of structured.scenarios) {
        for (const tool of scenario.recommended_tools) {
          expect(toolNames.has(tool), `${scenario.id} routes to registered ${tool}`).toBe(true);
        }
        const specific = await client.callTool({
          name: 'bpm_workflow_catalog',
          arguments: { scenario_id: scenario.id },
        });
        const specificText = specific.content
          .filter((item) => item.type === 'text')
          .map((item) => item.text)
          .join('\n');
        expect(specificText).not.toMatch(APP_VERSION);
        expect(JSON.stringify(specific.structuredContent)).not.toMatch(APP_VERSION);
      }

      const massUpdate = structured.scenarios.find((scenario) => scenario.id === 'mass-update');
      const massDelete = structured.scenarios.find((scenario) => scenario.id === 'mass-delete');
      expect(massUpdate?.notes).toContain('confirmation_token');
      expect(massDelete?.notes).toContain('confirm=true');
      expect(massUpdate?.notes).toMatch(/явн.*подтверж/i);
      expect(massDelete?.notes).toMatch(/явн.*подтверж/i);
    } finally {
      await client.close();
    }
  });
});
