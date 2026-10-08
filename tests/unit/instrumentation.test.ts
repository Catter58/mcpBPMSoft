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
import { READ_RESULT_BYTE_LIMIT, serializedResultBytes } from '../../src/server/response-budget.js';

function errorResult(error: unknown) {
  return {
    content: [{ type: 'text', text: JSON.stringify(formatToolError(error, 'Contact'), null, 2) }],
    isError: true,
  };
}

type TestNextAction = {
  kind: string;
  tool: string;
  arguments: Record<string, unknown>;
  [key: string]: unknown;
};

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
        { step: 'create', index: 1, state: 'completed', id: 'fixture-image' },
        { step: 'upload', index: 2, state: 'outcome_unknown' },
      ],
      verification_args: [
        {
          index: 1,
          collection: 'Contact',
          id: '00000000-0000-4000-8000-000000000002',
          verify: { operation: 'update', expected: { Name: 'Wrong row' } },
        },
        {
          index: 2,
          collection: 'Contact',
          id: '00000000-0000-4000-8000-000000000001',
          verify: { operation: 'update', expected: { Name: 'Example' } },
          access_token: 'must not be echoed',
        },
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
    expect(result.structuredContent).toMatchObject({
      ...failure,
      next_action: {
        kind: 'verify',
        tool: 'bpm_get_record',
        arguments: {
          collection: 'Contact',
          id: '00000000-0000-4000-8000-000000000001',
          verify: { operation: 'update', expected: { Name: 'Example' } },
        },
        requires_user_input: false,
      },
    });
    expect(JSON.stringify((result.structuredContent as Record<string, unknown>).next_action)).not.toContain(
      'must not be echoed'
    );
    expect(result.isError).toBe(true);
  });

  it('emits a validated single-record confirmation action using only prepared plan fields', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const server = instrumentTools(new McpServer({ name: 'test-server', version: '1.0.0' }));
    const received: Array<Record<string, unknown>> = [];
    server.registerTool(
      'bpm_delete_record',
      {
        inputSchema: {
          collection: z.string(),
          id: z.string(),
          confirm: z.boolean().optional(),
          confirmation_token: z.string().optional(),
        },
        outputSchema: {
          collection: z.string(),
          id: z.string(),
          record: z.record(z.string(), z.unknown()).optional(),
          requires_confirmation: z.boolean().optional(),
          confirmation_token: z.string().optional(),
          deleted: z.boolean().optional(),
        },
      },
      async (args) => {
        received.push(args as Record<string, unknown>);
        return args.confirm
          ? {
              content: [{ type: 'text', text: 'deleted' }],
              structuredContent: { collection: 'Account', id: 'fixture-id', deleted: true },
            }
          : {
              content: [{ type: 'text', text: 'preview' }],
              structuredContent: {
                collection: 'Account',
                id: 'fixture-id',
                record: { password: 'never-copy' },
                requires_confirmation: true,
                confirmation_token: 'plan-token',
              },
            };
      }
    );
    const { client } = await connect(server);
    const preview = await client.callTool({
      name: 'bpm_delete_record',
      arguments: { collection: 'Account', id: 'fixture-id' },
    });
    expect(preview.structuredContent).toMatchObject({
      next_action: {
        kind: 'confirm',
        tool: 'bpm_delete_record',
        arguments: {
          collection: 'Account',
          id: 'fixture-id',
          confirm: true,
          confirmation_token: 'plan-token',
        },
        confirmation: { required: true },
        requires_user_input: true,
      },
    });
    expect(JSON.stringify((preview.structuredContent as Record<string, unknown>).next_action)).not.toContain(
      'never-copy'
    );
    const action = (preview.structuredContent as Record<string, unknown>).next_action as TestNextAction;
    const completed = await client.callTool({ name: action.tool, arguments: action.arguments });
    expect(completed.isError).not.toBe(true);
    expect(received[1]).toEqual(action.arguments);
  });

  it.each([
    {
      name: 'bpm_batch_create',
      shape: { steps: z.array(z.unknown()) },
      prepared: { steps: [{ alias: 'account', collection: 'Account', record: { Name: 'A' } }] },
    },
    {
      name: 'bpm_batch_update',
      shape: {
        collection: z.string(),
        updates: z.array(z.unknown()),
        continue_on_error: z.boolean().optional(),
      },
      prepared: {
        collection: 'Account',
        updates: [{ id: 'fixture-id', data: { Score: 2 } }],
        continue_on_error: false,
      },
    },
    {
      name: 'bpm_batch_delete',
      shape: { collection: z.string(), ids: z.array(z.string()), continue_on_error: z.boolean().optional() },
      prepared: { collection: 'Account', ids: ['fixture-id'], continue_on_error: false },
    },
    {
      name: 'bpm_field_delete',
      shape: { collection: z.string(), id: z.string(), field: z.string() },
      prepared: { collection: 'Account', id: 'fixture-id', field: 'Photo' },
    },
    {
      name: 'bpm_run_process',
      shape: {
        process_name: z.string(),
        parameters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
        result_parameter_name: z.string().optional(),
      },
      prepared: { process_name: 'UsrTestProcess', parameters: { recordId: 'fixture-id' } },
    },
    {
      name: 'bpm_exec_process_element',
      shape: { element_uid: z.string() },
      prepared: { element_uid: 'fixture-element' },
    },
  ])('produces a strict-SDK-valid confirmation follow-up for $name', async ({ name, shape, prepared }) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const server = instrumentTools(new McpServer({ name: 'test-server', version: '1.0.0' }));
    const token = 'fresh-plan-token';
    let confirmed = false;
    server.registerTool(
      name,
      {
        inputSchema: z.strictObject({
          ...shape,
          confirm: z.boolean().optional(),
          confirmation_token: z.string().optional(),
        }),
        outputSchema: z.looseObject({}),
      },
      async (args) => {
        if (args.confirm === true) confirmed = true;
        return args.confirm === true
          ? { content: [{ type: 'text', text: 'done' }], structuredContent: { done: true } }
          : {
              content: [{ type: 'text', text: 'prepared plan' }],
              structuredContent: {
                requires_confirmation: true,
                confirmation_token: token,
                normalized_args: prepared,
              },
            };
      }
    );
    const { client } = await connect(server);
    const preview = await client.callTool({ name, arguments: prepared });
    const action = (preview.structuredContent as Record<string, unknown>)?.next_action as TestNextAction;
    expect(action).toMatchObject({
      kind: 'confirm',
      tool: name,
      requires_user_input: true,
      arguments: { ...prepared, confirm: true, confirmation_token: token },
      confirmation: { required: true },
    });
    const execution = await client.callTool({ name, arguments: action.arguments });
    expect(execution.isError).not.toBe(true);
    expect(confirmed).toBe(true);
  });

  it('uses ask_user for blockers and decoded JSON clarification errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const server = instrumentTools(new McpServer({ name: 'test-server', version: '1.0.0' }));
    server.registerTool(
      'create_preview',
      { outputSchema: { ready: z.boolean(), blockers: z.array(z.unknown()).optional() } },
      async () => ({
        content: [{ type: 'text', text: 'missing title' }],
        structuredContent: { ready: false, blockers: [{ field: 'Title' }] },
      })
    );
    server.registerTool('update_record', { outputSchema: { collection: z.string() } }, async () => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: false,
            code: 'lookup_ambiguous',
            error: 'Choose a contact',
            suggestions: ['A', 'B'],
          }),
        },
      ],
      isError: true,
    }));
    const { client } = await connect(server);
    const blocker = await client.callTool({ name: 'create_preview' });
    expect(blocker.structuredContent).toMatchObject({
      next_action: { kind: 'ask_user', requires_user_input: true },
    });
    const clarification = await client.callTool({ name: 'update_record' });
    expect(clarification.structuredContent).toMatchObject({
      success: false,
      code: 'lookup_ambiguous',
      next_action: { kind: 'ask_user' },
    });
    expect(clarification.isError).toBe(true);
    expect(clarification.content).toHaveLength(2);
    expect((clarification.content[0] as { text: string }).text).toContain('lookup_ambiguous');
    expect((clarification.content[1] as { text: string }).text).toContain('Next action:');
  });

  it('keeps safe retries in preview mode, validates cursor-only next_page, and emits complete only for explicit completion', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const server = instrumentTools(new McpServer({ name: 'test-server', version: '1.0.0' }));
    const retries: Array<Record<string, unknown>> = [];
    server.registerTool(
      'bpm_batch_update',
      {
        inputSchema: {
          collection: z.string(),
          updates: z.array(z.unknown()),
          confirm: z.boolean().optional(),
        },
        outputSchema: {
          collection: z.string(),
          safe_retry_indices: z.array(z.number()).optional(),
          retry_args: z.record(z.string(), z.unknown()).optional(),
          previewed: z.boolean().optional(),
        },
      },
      async (args) => {
        retries.push(args as Record<string, unknown>);
        return args.confirm === false
          ? {
              content: [{ type: 'text', text: 'preview' }],
              structuredContent: { collection: 'Account', previewed: true },
            }
          : {
              content: [{ type: 'text', text: 'partial' }],
              structuredContent: {
                collection: 'Account',
                safe_retry_indices: [2],
                retry_args: { collection: 'Account', updates: [{ id: 'owned-id', data: { Score: 5 } }] },
              },
            };
      }
    );
    server.registerTool(
      'bpm_get_records',
      {
        inputSchema: { collection: z.string().optional(), cursor: z.string().optional() },
        outputSchema: {
          has_more: z.boolean(),
          cursor: z.string().optional(),
          continued: z.boolean().optional(),
        },
        annotations: { readOnlyHint: true },
      },
      async (args) =>
        args.cursor
          ? {
              content: [{ type: 'text', text: 'second page' }],
              structuredContent: { has_more: false, continued: true },
            }
          : {
              content: [{ type: 'text', text: 'first page' }],
              structuredContent: { has_more: true, cursor: 'next-cursor' },
            }
    );
    server.registerTool('explicit_done', { outputSchema: { state: z.string() } }, async () => ({
      content: [{ type: 'text', text: 'done' }],
      structuredContent: { state: 'completed' },
    }));
    server.registerTool('verify_unavailable', { outputSchema: { verification: z.unknown() } }, async () => ({
      content: [{ type: 'text', text: 'unavailable' }],
      structuredContent: { verification: { observation: 'unavailable' } },
    }));
    const { client } = await connect(server);
    const retry = await client.callTool({
      name: 'bpm_batch_update',
      arguments: { collection: 'Account', updates: [] },
    });
    expect(retry.isError).not.toBe(true);
    const retryAction = (retry.structuredContent as Record<string, unknown>).next_action as TestNextAction;
    expect(retryAction).toMatchObject({ kind: 'retry_preview', arguments: { confirm: false } });
    const retriedPreview = await client.callTool({
      name: retryAction.tool,
      arguments: retryAction.arguments,
    });
    expect(retriedPreview.structuredContent).toMatchObject({ previewed: true });
    expect(retries[1]).toMatchObject({ confirm: false, updates: [{ id: 'owned-id' }] });

    const page = await client.callTool({ name: 'bpm_get_records', arguments: { collection: 'Account' } });
    const next = (page.structuredContent as Record<string, unknown>).next_action as TestNextAction;
    expect(next).toMatchObject({ kind: 'next_page', arguments: { cursor: 'next-cursor' } });
    const continued = await client.callTool({ name: next.tool, arguments: next.arguments });
    expect(continued.structuredContent).toMatchObject({ continued: true });
    expect(page.content[0]).toMatchObject({ text: expect.stringContaining('first page') });
    expect(page.content[0]).toMatchObject({ text: expect.stringContaining('Next action:') });

    const done = await client.callTool({ name: 'explicit_done' });
    expect(done.structuredContent).toMatchObject({
      next_action: { kind: 'complete', requires_user_input: false },
    });
    const unavailable = await client.callTool({ name: 'verify_unavailable' });
    expect(unavailable.structuredContent).toEqual({ verification: { observation: 'unavailable' } });
  });

  it('omits optional pagination enrichment when duplicating a cursor would exceed the read byte budget', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const cursor = 'c'.repeat(64_000);
    const base = {
      content: [{ type: 'text' as const, text: 'page' }],
      structuredContent: { has_more: true, cursor },
    };
    const expectedAction = {
      kind: 'next_page',
      tool: 'bpm_get_records',
      arguments: { cursor },
      reason: 'Доступна следующая страница результатов.',
      requires_user_input: false,
    };
    const rawBytes = serializedResultBytes(base);
    const enrichedBytes = serializedResultBytes({
      content: [{ type: 'text', text: `page\n\nNext action: ${JSON.stringify(expectedAction)}` }],
      structuredContent: { ...base.structuredContent, next_action: expectedAction },
    });
    expect(rawBytes).toBeLessThanOrEqual(READ_RESULT_BYTE_LIMIT);
    expect(enrichedBytes).toBeGreaterThan(READ_RESULT_BYTE_LIMIT);
    const server = instrumentTools(new McpServer({ name: 'test-server', version: '1.0.0' }));
    server.registerTool(
      'bpm_get_records',
      {
        inputSchema: { collection: z.string().optional(), cursor: z.string().optional() },
        outputSchema: { has_more: z.boolean(), cursor: z.string() },
        annotations: { readOnlyHint: true },
      },
      async () => base
    );
    const { client } = await connect(server);
    const result = await client.callTool({ name: 'bpm_get_records', arguments: { collection: 'Account' } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ has_more: true, cursor });
    expect((result.structuredContent as Record<string, unknown>).next_action).toBeUndefined();
  });

  it('does not emit unsafe confirmation or retry actions after redaction or schema mismatch', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const server = instrumentTools(new McpServer({ name: 'test-server', version: '1.0.0' }));
    server.registerTool(
      'confirm_sensitive',
      {
        inputSchema: z.strictObject({
          collection: z.string(),
          data: z.record(z.string(), z.unknown()),
          confirm: z.boolean().optional(),
          confirmation_token: z.string().optional(),
        }),
        outputSchema: z.looseObject({}),
      },
      async () => ({
        content: [{ type: 'text', text: 'plan' }],
        structuredContent: {
          requires_confirmation: true,
          confirmation_token: 'token',
          normalized_args: { collection: 'Account', data: { access_token: 'secret-value' } },
        },
      })
    );
    server.registerTool(
      'retry_strict',
      {
        inputSchema: z.strictObject({ collection: z.string(), updates: z.array(z.unknown()) }),
        outputSchema: z.looseObject({}),
      },
      async () => ({
        content: [{ type: 'text', text: 'partial' }],
        structuredContent: {
          safe_retry_indices: [0],
          retry_args: { collection: 'Account', updates: [], confirm: true },
        },
      })
    );
    const { client } = await connect(server);
    const confirmation = await client.callTool({
      name: 'confirm_sensitive',
      arguments: { collection: 'Account', data: {} },
    });
    expect(confirmation.structuredContent).toMatchObject({
      next_action: { kind: 'ask_user', requires_user_input: true },
    });
    expect(JSON.stringify(confirmation.structuredContent?.next_action)).not.toContain('secret-value');
    const retry = await client.callTool({
      name: 'retry_strict',
      arguments: { collection: 'Account', updates: [] },
    });
    expect((retry.structuredContent as Record<string, unknown>).next_action).toBeUndefined();
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
