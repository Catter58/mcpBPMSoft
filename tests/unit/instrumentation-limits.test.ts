import { describe, it, expect } from 'vitest';
import * as z from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CHARACTER_LIMIT, instrumentTools, limitResultText } from '../../src/server/instrumentation.js';

async function connect(text: string) {
  const server = instrumentTools(new McpServer({ name: 't', version: '1' }));
  server.registerTool(
    'bpm_x',
    { inputSchema: { filter: z.string().optional(), top: z.number().optional() } },
    async () => ({ content: [{ type: 'text', text }] })
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'c', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

describe('строгие параметры инструментов', () => {
  it('неизвестный параметр — ошибка с ближайшим допустимым именем', async () => {
    const client = await connect('ok');
    const res = await client.callTool({ name: 'bpm_x', arguments: { filters: 'x' } });
    expect(res.isError).toBe(true);
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('«filters» — возможно, «filter»');
  });

  it('допустимые параметры проходят, схема закрыта для лишних ключей', async () => {
    const client = await connect('ok');
    const res = await client.callTool({ name: 'bpm_x', arguments: { filter: 'x' } });
    expect(res.isError).toBeFalsy();
    const { tools } = await client.listTools();
    expect(tools[0].inputSchema.additionalProperties).toBe(false);
  });
});

describe('лимит текста ответа', () => {
  it('короткий ответ не трогает', () => {
    const r = { content: [{ type: 'text', text: 'abc' }] };
    expect(limitResultText(r)).toBe(r);
  });

  it('длинный обрезает до лимита и объясняет', async () => {
    const client = await connect('x'.repeat(CHARACTER_LIMIT + 500));
    const res = await client.callTool({ name: 'bpm_x', arguments: {} });
    const parts = res.content as Array<{ text: string }>;
    expect(parts[0].text.length).toBe(CHARACTER_LIMIT);
    expect(parts[1].text).toContain('Ответ обрезан');
  });
});
