import { describe, it, expect, vi, afterEach } from 'vitest';
import * as z from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CHARACTER_LIMIT,
  describeToolError,
  getToolStats,
  instrumentTools,
  resetToolStats,
} from '../../src/server/instrumentation.js';
import { BpmApiError, formatToolError, UnknownFieldError } from '../../src/utils/errors.js';

function errorResult(error: unknown) {
  return {
    content: [{ type: 'text', text: JSON.stringify(formatToolError(error, 'Contact'), null, 2) }],
    isError: true,
  };
}

describe('describeToolError', () => {
  it('берёт статус, код, текст и детали из ответа formatToolError', () => {
    const error = new BpmApiError('Недостаточно прав', 403, 'SysAdminUnit', 'OData: access denied');
    expect(describeToolError(errorResult(error))).toBe(
      '403 auth_required: Недостаточно прав | OData: access denied'
    );
    expect(describeToolError(errorResult(new UnknownFieldError('Город', 'Contact', [])))).toBe(
      '400 validation: Поле "Город" не найдено в коллекции Contact'
    );
  });

  it('не повторяет details, совпадающие с сообщением', () => {
    const error = new BpmApiError('Поле ФИО обязательно', 500, 'Contact', 'Поле ФИО обязательно');
    expect(describeToolError(errorResult(error))).toBe('500 odata_error: Поле ФИО обязательно');
    const withHint = new BpmApiError(
      'Поле ФИО обязательно',
      500,
      'Contact',
      'Поле ФИО обязательно Запрос POST мог выполниться'
    );
    expect(describeToolError(errorResult(withHint))).toBe(
      '500 odata_error: Поле ФИО обязательно | Запрос POST мог выполниться'
    );
  });

  it('статус 0 (сеть) не печатает, оставляет код и сообщение', () => {
    expect(describeToolError(errorResult(new BpmApiError('Сетевая ошибка: terminated', 0)))).toBe(
      'odata_error: Сетевая ошибка: terminated'
    );
  });

  it('не-JSON ответ отдаёт текстом в одну строку, длинный обрезает', () => {
    expect(describeToolError({ content: [{ type: 'text', text: 'строка 1\nстрока 2' }] })).toBe(
      'строка 1 строка 2'
    );
    expect(describeToolError({ content: [{ type: 'text', text: 'x'.repeat(500) }] })).toHaveLength(301);
    expect(describeToolError({ content: [] })).toBe('без описания');
  });

  it('разбирает брошенное исключение', () => {
    expect(describeToolError(new BpmApiError('Запись не найдена', 404))).toBe(
      '404 not_found: Запись не найдена'
    );
  });
});

describe('instrumentTools', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetToolStats();
  });

  it('пишет в лог причину ошибки', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const server = {
      registerTool: (name: string, _config: unknown, handler: (...args: unknown[]) => unknown) =>
        handlers.set(name, handler),
    } as unknown as McpServer;
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    instrumentTools(server);
    server.registerTool('bpm_x', {}, async () => errorResult(new BpmApiError('Плохой $filter', 400)));
    await handlers.get('bpm_x')!();

    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/^\[tool\] bpm_x \d+ms error 400 validation: Плохой \$filter/)
    );
  });
});

describe('instrumentTools MCP contract', () => {
  const clients: Client[] = [];

  async function connect(server: McpServer) {
    const client = new Client({ name: 'output-contract-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    clients.push(client);
    // SDK caches output validators here: calling handlers directly misses this boundary.
    const listed = await client.listTools();
    return { client, listed };
  }

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close();
    vi.restoreAllMocks();
    resetToolStats();
  });

  it('advertises success or a defined error envelope and delivers missing fields', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const server = instrumentTools(new McpServer({ name: 'test-server', version: '1.0.0' }));
    const failure = {
      success: false,
      code: 'validation',
      error: 'Name is required',
      httpStatus: 400,
      collection: 'Contact',
      missing_fields: [{ name: 'Name', caption: 'Full name', type: 'Edm.String' }],
      next_steps: ['Provide Name'],
    };
    server.registerTool(
      'create_record',
      {
        inputSchema: { name: z.string().optional() },
        outputSchema: { record: z.object({ Name: z.string() }) },
      },
      async ({ name }) =>
        name
          ? { content: [{ type: 'text', text: name }], structuredContent: { record: { Name: name } } }
          : {
              content: [{ type: 'text', text: JSON.stringify(failure) }],
              structuredContent: failure,
              isError: true,
            }
    );
    const { client, listed } = await connect(server);
    expect(listed.tools[0].outputSchema).toMatchObject({
      type: 'object',
      anyOf: [
        { type: 'object', required: ['record'], additionalProperties: false },
        { type: 'object', required: ['success', 'error'] },
      ],
    });
    const error = await client.callTool({ name: 'create_record', arguments: {} });
    expect(error).toMatchObject({ isError: true, structuredContent: failure });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/error 400 validation: Name is required/));
    const success = await client.callTool({ name: 'create_record', arguments: { name: 'Example' } });
    expect(success.structuredContent).toEqual({ record: { Name: 'Example' } });
    expect(success.isError).not.toBe(true);
    expect(getToolStats().create_record).toMatchObject({ calls: 2, errors: 1 });
  });

  it('preserves partial outcomes and tool-specific diagnostics in errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const server = instrumentTools(new McpServer({ name: 'test-server', version: '1.0.0' }));
    const failure = {
      success: false,
      code: 'outcome_unknown',
      error: 'The final upload outcome could not be determined',
      safe_to_retry: false,
      partial_result: { image_id: 'fixture-image', linked: false },
      outcomes: [
        { step: 'create', state: 'completed', id: 'fixture-image' },
        { step: 'upload', state: 'outcome_unknown' },
      ],
      errors: [{ index: 1, reason: 'Connection closed', missing_fields: [] }],
    };
    server.registerTool(
      'upload',
      { outputSchema: { image_id: z.string(), linked: z.boolean() } },
      async () => ({
        content: [{ type: 'text', text: failure.error }],
        structuredContent: failure,
        isError: true,
      })
    );
    const { client } = await connect(server);
    const result = await client.callTool({ name: 'upload' });
    expect(result.structuredContent).toEqual(failure);
    expect(result.isError).toBe(true);
  });

  it.each([
    ['missing required success field', {}],
    ['invalid success field type', { record: { Name: 42 } }],
    ['unexpected success property', { record: { Name: 'Example' }, extra: true }],
    ['error envelope presented as success', { success: false, error: 'Invalid input' }],
  ])('rejects %s without broadening successful output validation', async (_label, payload) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const server = instrumentTools(new McpServer({ name: 'test-server', version: '1.0.0' }));
    server.registerTool(
      'invalid_success',
      { outputSchema: { record: z.object({ Name: z.string() }) } },
      async () => ({
        content: [{ type: 'text', text: 'Incorrect success' }],
        structuredContent: payload,
      })
    );
    const { client } = await connect(server);
    const result = await client.callTool({ name: 'invalid_success' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content).toEqual([
      { type: 'text', text: expect.stringContaining('Output validation error') },
    ]);
    expect(getToolStats().invalid_success).toMatchObject({ calls: 1, errors: 1 });
  });

  it('does not advertise an unconstrained structured error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const server = instrumentTools(new McpServer({ name: 'test-server', version: '1.0.0' }));
    server.registerTool(
      'invalid_error',
      { outputSchema: { record: z.object({ Name: z.string() }) } },
      async () => ({
        content: [{ type: 'text', text: 'Malformed error' }],
        structuredContent: { success: false, error: 42 },
        isError: true,
      })
    );
    const { client } = await connect(server);
    await expect(client.callTool({ name: 'invalid_error' })).rejects.toThrow(
      "Structured content does not match the tool's output schema"
    );
  });

  it.each(['raw shape', 'constructed object'])(
    'rejects unknown input keys for %s and preserves refinements',
    async (kind) => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const server = instrumentTools(new McpServer({ name: 'test-server', version: '1.0.0' }));
      const handler = vi.fn(async ({ value }: { value: number }) => ({
        content: [{ type: 'text' as const, text: String(value) }],
      }));
      const shape = { value: z.number().int().positive() };
      const schema =
        kind === 'raw shape'
          ? shape
          : z.object(shape).refine(({ value }) => value % 2 === 0, { message: 'Use an even value' });
      server.registerTool('strict_input', { inputSchema: schema }, handler);
      const { client, listed } = await connect(server);
      expect(listed.tools[0].inputSchema.additionalProperties).toBe(false);
      const unknown = await client.callTool({ name: 'strict_input', arguments: { value: 2, vlue: 3 } });
      expect(unknown.isError).toBe(true);
      expect(unknown.content).toEqual([
        { type: 'text', text: expect.stringContaining('«vlue» — возможно, «value»') },
      ]);
      expect(handler).not.toHaveBeenCalled();
      const invalid = await client.callTool({
        name: 'strict_input',
        arguments: { value: kind === 'raw shape' ? -1 : 3 },
      });
      expect(invalid.isError).toBe(true);
      if (kind === 'constructed object')
        expect(invalid.content).toEqual([
          { type: 'text', text: expect.stringContaining('Use an even value') },
        ]);
      expect(handler).not.toHaveBeenCalled();
      const valid = await client.callTool({ name: 'strict_input', arguments: { value: 2 } });
      expect(valid.isError).not.toBe(true);
      expect(handler).toHaveBeenCalledOnce();
    }
  );

  it('limits wire text while keeping successful structured data complete', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const server = instrumentTools(new McpServer({ name: 'test-server', version: '1.0.0' }));
    const text = 'x'.repeat(CHARACTER_LIMIT + 100);
    server.registerTool('long_result', { outputSchema: { value: z.string() } }, async () => ({
      content: [{ type: 'text', text }],
      structuredContent: { value: text },
    }));
    const { client } = await connect(server);
    const result = await client.callTool({ name: 'long_result' });
    expect(result.structuredContent).toEqual({ value: text });
    expect(result.content).toEqual([
      { type: 'text', text: text.slice(0, CHARACTER_LIMIT) },
      { type: 'text', text: expect.stringContaining('[Ответ обрезан:') },
    ]);
  });
});
