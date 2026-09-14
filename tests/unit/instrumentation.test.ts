import { describe, it, expect, vi, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describeToolError, instrumentTools, resetToolStats } from '../../src/server/instrumentation.js';
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
