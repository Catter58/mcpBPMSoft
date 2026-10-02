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

import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { suggest } from '../utils/suggest.js';

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

/**
 * Потолок текста ответа модели. Больше — почти всегда выгрузка, которую надо было сузить
 * фильтром/select; обрезаем с объяснением, а не заливаем окно контекста.
 * ponytail: режется только text, structuredContent отдаётся целиком — ограничить и его,
 * если клиенты начнут пересылать его модели как есть.
 */
export const CHARACTER_LIMIT = 25_000;

/**
 * Сырой shape инструмента → строгий объект: неизвестный ключ (`filters` вместо `filter`)
 * раньше молча отбрасывался, и модель получала не то, что просила. Теперь — ошибка
 * с ближайшим допустимым именем.
 */
export function strictInputSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return schema;
  if (schema instanceof z.ZodObject) {
    // .strict() клонирует объект с его checks: существующие refinements не теряются.
    const strict = schema.strict();
    const previousError = strict.def.error;
    const hints = inputErrorHints(Object.keys(strict.shape));
    return strict.clone({
      ...strict.def,
      error: (issue) => hints(issue) ?? previousError?.(issue),
    });
  }
  if (schema instanceof z.ZodType) return schema;
  const shape = schema as z.ZodRawShape;
  return z.strictObject(shape, { error: inputErrorHints(Object.keys(shape)) });
}

function inputErrorHints(known: string[]): z.core.$ZodErrorMap {
  return (issue) => {
    if (issue.code !== 'unrecognized_keys') return undefined;
    const hints = issue.keys.map((key) => {
      const [best] = suggest(key, known, { maxResults: 1 });
      return best ? `«${key}» — возможно, «${best}»` : `«${key}»`;
    });
    return `Неизвестные параметры: ${hints.join(', ')}. Допустимые: ${known.join(', ')}.`;
  };
}

/** Общий контракт ошибок; дополнительные поля сохраняют диагностику конкретного инструмента. */
const toolErrorSchema = z.looseObject({
  success: z.literal(false),
  error: z.string(),
  code: z.string().optional(),
  httpStatus: z.number().optional(),
  collection: z.string().optional(),
  details: z.string().optional(),
  suggestions: z.array(z.string()).optional(),
  next_steps: z.array(z.string()).optional(),
  safe_to_retry: z.boolean().optional(),
});

function outputSchemaWithErrors(schema: unknown) {
  const success = schema instanceof z.ZodType ? schema : z.strictObject(schema as z.ZodRawShape);
  const outcomes = z.union([success, toolErrorSchema]);
  // SDK принимает в outputSchema только object, но клиент проверяет structuredContent
  // даже при isError=true. Один union описывает обе ветки и для Zod, и для tools/list.
  const published = z
    .looseObject({})
    .superRefine(async (value, context) => {
      const parsed = await outcomes.safeParseAsync(value);
      if (!parsed.success) context.addIssue({ code: 'custom', message: parsed.error.message });
    })
    .meta({ ...z.toJSONSchema(outcomes, { target: 'draft-7', io: 'output' }), type: 'object' });
  return { success, published };
}

/** Обрезает текстовые части ответа до CHARACTER_LIMIT с пояснением для модели. */
export function limitResultText(result: unknown): unknown {
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
  if (!Array.isArray(content)) return result;
  const total = content.reduce((n, part) => n + (part.type === 'text' ? (part.text?.length ?? 0) : 0), 0);
  if (total <= CHARACTER_LIMIT) return result;
  let left = CHARACTER_LIMIT;
  const trimmed = content.map((part) => {
    if (part.type !== 'text' || typeof part.text !== 'string') return part;
    const text = part.text.slice(0, Math.max(0, left));
    left -= text.length;
    return { ...part, text };
  });
  trimmed.push({
    type: 'text',
    text:
      `\n[Ответ обрезан: ${CHARACTER_LIMIT} из ${total} символов. Сузьте выборку — фильтр, top, select — ` +
      'полные данные есть в structuredContent.]',
  });
  return { ...(result as object), content: trimmed };
}

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
    const cfg = config as { inputSchema?: unknown; outputSchema?: unknown } | undefined;
    const output = cfg?.outputSchema ? outputSchemaWithErrors(cfg.outputSchema) : undefined;
    const wrapped = async (...args: unknown[]) => {
      const started = Date.now();
      try {
        const result = await handler(...args);
        const isError = Boolean((result as { isError?: boolean } | undefined)?.isError);
        if (output && !isError) {
          // Ветка ошибки не должна принимать повреждённый успешный ответ.
          const parsed = await output.success.safeParseAsync(
            (result as { structuredContent?: unknown } | undefined)?.structuredContent
          );
          if (!parsed.success)
            throw new Error(`Output validation error: Tool ${name}: ${parsed.error.message}`);
        }
        const ms = Date.now() - started;
        record(name, ms, isError);
        console.error(`[tool] ${name} ${ms}ms ${isError ? `error ${describeToolError(result)}` : 'ok'}`);
        return limitResultText(result);
      } catch (error) {
        const ms = Date.now() - started;
        record(name, ms, true);
        console.error(`[tool] ${name} ${ms}ms threw ${describeToolError(error)}`);
        throw error;
      }
    };
    const strictConfig = cfg
      ? {
          ...cfg,
          ...(cfg.inputSchema ? { inputSchema: strictInputSchema(cfg.inputSchema) } : {}),
          ...(output ? { outputSchema: output.published } : {}),
        }
      : config;
    return original(name, strictConfig, wrapped);
  };

  target.__instrumented = true;
  return server;
}
