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
        console.error(`[tool] ${name} ${ms}ms ${isError ? 'error' : 'ok'}`);
        return result;
      } catch (error) {
        const ms = Date.now() - started;
        record(name, ms, true);
        console.error(
          `[tool] ${name} ${ms}ms threw: ${error instanceof Error ? error.message : String(error)}`
        );
        throw error;
      }
    };
    return original(name, config, wrapped);
  };

  target.__instrumented = true;
  return server;
}
