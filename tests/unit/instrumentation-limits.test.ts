import { afterEach, describe, it, expect, vi } from 'vitest';
import * as z from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  CHARACTER_LIMIT,
  getToolStats,
  instrumentTools,
  limitResultText,
  resetToolStats,
} from '../../src/server/instrumentation.js';
import {
  enforceReadResultBudget,
  READ_RESULT_BYTE_LIMIT,
  serializedResultBytes,
} from '../../src/server/response-budget.js';

const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  vi.restoreAllMocks();
  resetToolStats();
});

async function connectServer(server: McpServer) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'c', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  clients.push(client);
  await client.listTools(); // Enables the client's published output-schema validation.
  return client;
}

async function connect(text: string) {
  const server = instrumentTools(new McpServer({ name: 't', version: '1' }));
  server.registerTool(
    'bpm_x',
    { inputSchema: { filter: z.string().optional(), top: z.number().optional() } },
    async () => ({ content: [{ type: 'text', text }] })
  );
  return connectServer(server);
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

async function callResult(
  result: CallToolResult,
  annotations: { readOnlyHint?: boolean } = { readOnlyHint: true }
) {
  const server = instrumentTools(new McpServer({ name: 'budget-test', version: '1' }));
  server.registerTool(
    'bpm_result',
    { annotations, outputSchema: z.looseObject({ value: z.string() }) },
    async () => result
  );
  const client = await connectServer(server);
  return client.callTool({ name: 'bpm_result' });
}

function sizedResult(bytes: number): CallToolResult {
  const result: CallToolResult = { content: [], structuredContent: { value: '' } };
  result.structuredContent!.value = 'x'.repeat(bytes - serializedResultBytes(result));
  return result;
}

function expectRejection(result: CallToolResult, originalBytes: number) {
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    success: false,
    code: 'response_too_large',
    safe_to_retry: true,
    response_bytes: originalBytes,
    response_limit_bytes: READ_RESULT_BYTE_LIMIT,
    next_steps: expect.arrayContaining([
      expect.stringMatching(/filter.*auto_paginate=true.*max_records.*top/),
      expect.stringContaining('bpm_count_records'),
      expect.stringContaining('bpm_aggregate'),
    ]),
  });
  expect(Object.keys(result).sort()).toEqual(['content', 'isError', 'structuredContent']);
  expect(serializedResultBytes(result)).toBeLessThanOrEqual(READ_RESULT_BYTE_LIMIT);
}

describe('полный JSON-бюджет read-only ответа', () => {
  it('сохраняет короткий результат и принимает ровно 64 KiB', async () => {
    const short = { content: [], structuredContent: { value: 'ok' } };
    expect(enforceReadResultBudget(short)).toBe(short);
    const exact = sizedResult(READ_RESULT_BYTE_LIMIT);
    expect(serializedResultBytes(exact)).toBe(READ_RESULT_BYTE_LIMIT);
    expect(enforceReadResultBudget(exact)).toBe(exact);
    expect(await callResult(exact)).toEqual(exact);
  });

  it('отклоняет один лишний байт в structuredContent через опубликованный контракт', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const original = sizedResult(READ_RESULT_BYTE_LIMIT + 1);
    expectRejection(await callResult(original), READ_RESULT_BYTE_LIMIT + 1);
    expect(getToolStats().bpm_result).toMatchObject({ calls: 1, errors: 1 });
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/error response_too_large:/));
  });

  it.each([
    ['UTF-8', 'я'.repeat(33_000)],
    ['JSON escaping', '\\'.repeat(33_000)],
  ])('учитывает %s, а не только длину строки', async (_label, value) => {
    const original: CallToolResult = { content: [], structuredContent: { value } };
    expect(value.length).toBeLessThan(READ_RESULT_BYTE_LIMIT);
    expectRejection(await callResult(original), Buffer.byteLength(JSON.stringify(original), 'utf8'));
  });

  it('считает все текстовые блоки до legacy-обрезки, не отдавая строки или cursor', async () => {
    const original: CallToolResult = {
      content: [
        { type: 'text', text: 'x'.repeat(33_000) },
        { type: 'text', text: 'y'.repeat(33_000) },
      ],
      structuredContent: {
        value: 'ok',
        records: [{ Id: 'record-id' }],
        display_records: [{ Name: 'record-name' }],
        count: 1,
        has_more: true,
        cursor: 'next-page',
      },
      _meta: { marker: 'original-metadata' },
    };
    const result = await callResult(original);
    expectRejection(result, serializedResultBytes(original));
    const serialized = JSON.stringify(result);
    for (const omitted of ['"records":', 'record-id', 'record-name', 'next-page', 'original-metadata'])
      expect(serialized).not.toContain(omitted);
  });

  it.each(['image', 'resource', 'base64', 'metadata'])('учитывает %s за пределами text', async (kind) => {
    const payload = 'x'.repeat(READ_RESULT_BYTE_LIMIT);
    const original: CallToolResult = { content: [], structuredContent: { value: 'ok' } };
    if (kind === 'image') original.content = [{ type: 'image', data: payload, mimeType: 'image/png' }];
    if (kind === 'resource')
      original.content = [{ type: 'resource', resource: { uri: 'bpmsoft://fixture', text: payload } }];
    if (kind === 'base64') original.structuredContent!.content_base64 = payload;
    if (kind === 'metadata') original._meta = { payload };
    expectRejection(await callResult(original), serializedResultBytes(original));
  });

  it('повторно проверяет итоговый ответ с добавленным сообщением об обрезке', async () => {
    const original: CallToolResult = {
      content: [{ type: 'text', text: 'x'.repeat(CHARACTER_LIMIT + 1) }],
      structuredContent: { value: '' },
    };
    original.structuredContent!.value = 'x'.repeat(READ_RESULT_BYTE_LIMIT - serializedResultBytes(original));
    const clipped = limitResultText(original);
    expect(serializedResultBytes(original)).toBe(READ_RESULT_BYTE_LIMIT);
    expect(serializedResultBytes(clipped)).toBeGreaterThan(READ_RESULT_BYTE_LIMIT);
    expectRejection(await callResult(original), serializedResultBytes(clipped));
  });

  it('отклоняет большой ответ ошибки и не маскирует невалидный успешный контракт', async () => {
    const failure: CallToolResult = {
      content: [{ type: 'text', text: 'Failure' }],
      structuredContent: { success: false, error: 'x'.repeat(READ_RESULT_BYTE_LIMIT) },
      isError: true,
    };
    expectRejection(await callResult(failure), serializedResultBytes(failure));
    const invalid: CallToolResult = {
      content: [],
      structuredContent: { value: 42, extra: 'x'.repeat(READ_RESULT_BYTE_LIMIT) },
    };
    const result = await callResult(invalid);
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: 'text', text: expect.stringContaining('Output validation error') },
    ]);
    expect(result.structuredContent).toBeUndefined();
  });

  it.each([false, undefined])(
    'сохраняет успешные и частичные write-результаты при readOnlyHint=%s',
    async (readOnlyHint) => {
      const completed: CallToolResult = {
        content: [{ type: 'text', text: 'Write completed' }],
        structuredContent: {
          value: 'x'.repeat(READ_RESULT_BYTE_LIMIT),
          operation_ids: ['created-id'],
          outcomes: [{ id: 'created-id', state: 'succeeded' }],
        },
      };
      const completedResult = await callResult(completed, { readOnlyHint });
      expect(completedResult.structuredContent).toMatchObject({
        ...completed.structuredContent,
        next_action: { kind: 'complete', requires_user_input: false },
      });
      expect((completedResult.content as Array<{ text: string }>)[0].text).toContain('Write completed');
      expect((completedResult.content as Array<{ text: string }>)[0].text).toContain('Next action:');
      const partial: CallToolResult = {
        content: [{ type: 'text', text: 'Partial write' }],
        structuredContent: {
          success: false,
          error: 'x'.repeat(READ_RESULT_BYTE_LIMIT),
          safe_to_retry: false,
          partial_result: { id: 'created-id' },
          outcomes: [{ id: 'created-id', state: 'succeeded' }, { state: 'outcome_unknown' }],
        },
        isError: true,
      };
      const partialResult = await callResult(partial, { readOnlyHint });
      expect(partialResult.structuredContent).toMatchObject({
        ...partial.structuredContent,
        next_action: { kind: 'ask_user', requires_user_input: true },
      });
      expect((partialResult.content as Array<{ text: string }>)[0].text).toContain('Partial write');
    }
  );
});
