/**
 * Тайминги и исходы вызовов инструментов.
 *
 * Разбор «почему агент тупит» упирается в то, что по логам видно только HTTP-слой:
 * какой инструмент вызвали, сколько он занял и чем кончился — не видно вовсе.
 * Оборачиваем `registerTool` один раз при сборке сервера, поэтому замер получают
 * все инструменты сразу и ни один из них не приходится править.
 *
 * Пишем в stderr: stdout зарезервирован под stdio-транспорт MCP.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/** Длиннее в одну строку лога не нужно: полный ответ агент и так получает. */
const MAX_REASON_LENGTH = 300;

/** Счётчики за время жизни процесса. */
export interface ToolStats {
  calls: number;
  errors: number;
  totalMs: number;
  maxMs: number;
}

const stats = new Map<string, ToolStats>();

export function getToolStats(): Record<string, ToolStats> {
  return Object.fromEntries(stats.entries());
}

export function resetToolStats(): void {
  stats.clear();
}

function record(name: string, ms: number, isError: boolean): void {
  const entry = stats.get(name) ?? { calls: 0, errors: 0, totalMs: 0, maxMs: 0 };
  entry.calls += 1;
  if (isError) entry.errors += 1;
  entry.totalMs += ms;
  entry.maxMs = Math.max(entry.maxMs, ms);
  stats.set(name, entry);
}

type ToolHandler = (...args: unknown[]) => unknown;

function summarize(status: unknown, code: unknown, message: unknown, details?: unknown): string {
  const head = [
    typeof status === 'number' && status > 0 ? status : null,
    typeof code === 'string' ? code : null,
  ]
    .filter((part) => part !== null)
    .join(' ');
  // BPMSoft часто кладёт тот же текст и в message, и в details (иногда с дописанной подсказкой).
  const extra =
    typeof details === 'string' && typeof message === 'string' && details.startsWith(message)
      ? details.slice(message.length)
      : details;
  const text = [message, extra]
    .filter((part) => typeof part === 'string' && part.trim() !== '')
    .join(' | ')
    .replace(/\s+/g, ' ')
    .trim();
  const reason = text.length > MAX_REASON_LENGTH ? `${text.slice(0, MAX_REASON_LENGTH)}…` : text;
  return head && reason ? `${head}: ${reason}` : head || reason || 'без описания';
}

/**
 * Статус, код и текст ошибки в одну строку — из ответа инструмента с `isError`
 * или из брошенного исключения. Ответы об ошибках собирает `formatToolError`
 * (JSON с `httpStatus`/`code`/`error`/`details`); всё остальное берём как текст.
 */
export function describeToolError(outcome: unknown): string {
  if (outcome instanceof Error) {
    const error = outcome as Error & { httpStatus?: unknown; code?: unknown; details?: unknown };
    return summarize(error.httpStatus, error.code, error.message, error.details);
  }
  const content = (outcome as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
  const text = content?.find((part) => part.type === 'text')?.text ?? '';
  try {
    const body = JSON.parse(text) as Record<string, unknown> | null;
    if (body && typeof body === 'object' && 'error' in body) {
      return summarize(body.httpStatus, body.code, body.error, body.details);
    }
  } catch {
    // Не JSON — ниже возьмём текст как есть.
  }
  return summarize(undefined, undefined, text);
}

/**
 * Оборачивает обработчики инструментов сервера замером времени.
 * Возвращает тот же экземпляр — вызывать до регистрации инструментов.
 */
export function instrumentTools(server: McpServer): McpServer {
  const target = server as unknown as {
    registerTool: (name: string, config: unknown, handler: ToolHandler) => unknown;
    __instrumented?: boolean;
  };
  if (target.__instrumented) return server;

  const original = target.registerTool.bind(target);

  target.registerTool = (name: string, config: unknown, handler: ToolHandler) => {
    const wrapped = async (...args: unknown[]) => {
      const started = Date.now();
      try {
        const result = await handler(...args);
        const ms = Date.now() - started;
        const isError = Boolean((result as { isError?: boolean } | undefined)?.isError);
        record(name, ms, isError);
        console.error(`[tool] ${name} ${ms}ms ${isError ? `error ${describeToolError(result)}` : 'ok'}`);
        return result;
      } catch (error) {
        const ms = Date.now() - started;
        record(name, ms, true);
        console.error(`[tool] ${name} ${ms}ms threw ${describeToolError(error)}`);
        throw error;
      }
    };
    return original(name, config, wrapped);
  };

  target.__instrumented = true;
  return server;
}
