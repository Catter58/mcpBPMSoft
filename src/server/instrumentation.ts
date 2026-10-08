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
import {
  enforceReadResultBudget,
  limitResultText as applyResultTextLimit,
  READ_RESULT_TEXT_CHARACTER_LIMIT,
  READ_RESULT_BYTE_LIMIT,
  serializedResultBytes,
  serializedResultBytesAfterTextLimit,
} from './response-budget.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceContainer } from '../tools/init-tool.js';
import { withOperationJournal } from './operation-journal.js';
import { runWithReadBudget } from './request-runtime.js';
import { BpmApiError, formatToolError } from '../utils/errors.js';

/** Длиннее в одну строку лога не нужно: полный ответ агент и так получает. */
const MAX_REASON_LENGTH = 300;

const nextActionSchema = z.object({
  kind: z.enum(['ask_user', 'call_tool', 'confirm', 'verify', 'retry_preview', 'next_page', 'complete']),
  tool: z.string().optional(),
  arguments: z.record(z.string(), z.unknown()).optional(),
  reason: z.string(),
  requires_user_input: z.boolean(),
  confirmation: z.object({ required: z.literal(true), prompt: z.string() }).optional(),
});

type NextAction = z.infer<typeof nextActionSchema>;

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function removeSensitiveKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(removeSensitiveKeys);
  const object = objectValue(value);
  if (!object) return value;
  return Object.fromEntries(
    Object.entries(object)
      .filter(([key]) => !/(password|passwd|secret|token|cookie|authorization|credential|csrf)/i.test(key))
      .map(([key, item]) => [key, removeSensitiveKeys(item)])
  );
}

function allowedInputKeys(schema: unknown): Set<string> {
  if (schema instanceof z.ZodObject) return new Set(Object.keys(schema.shape));
  if (!schema || typeof schema !== 'object') return new Set();
  return new Set(Object.keys(schema));
}

function inputArgsMatchSchema(schema: unknown, args: Record<string, unknown>): boolean {
  if (schema instanceof z.ZodType) return schema.safeParse(args).success;
  if (!schema || typeof schema !== 'object') return false;
  return z.strictObject(schema as z.ZodRawShape).safeParse(args).success;
}

function parseOutputEnvelope(result: CallToolResult): Record<string, unknown> | undefined {
  const existing = objectValue(result.structuredContent);
  if (existing) return existing;
  for (const part of result.content ?? []) {
    if (part.type !== 'text') continue;
    try {
      const parsed = objectValue(JSON.parse(part.text));
      if (parsed && (parsed.success === false || typeof parsed.error === 'string')) return parsed;
    } catch {
      // Keep ordinary prose untouched.
    }
  }
  return undefined;
}

/** Pick one safe, machine-readable action from explicit response state only. */
function inferNextAction(name: string, outcome: unknown, inputSchema?: unknown): NextAction | undefined {
  const result = objectValue(outcome);
  const structured = objectValue(result?.structuredContent) ?? result;
  if (!structured) return undefined;
  const unknownOutcome =
    structured.code === 'outcome_unknown' ||
    structured.state === 'outcome_unknown' ||
    (Array.isArray(structured.outcomes) &&
      structured.outcomes.some((item) => objectValue(item)?.state === 'outcome_unknown'));
  if (unknownOutcome) {
    const rawVerification = structured.verification_args;
    const unknownIndexes = new Set(
      (Array.isArray(structured.outcomes) ? structured.outcomes : [])
        .map((item) => objectValue(item))
        .filter((item) => item?.state === 'outcome_unknown' && typeof item.index === 'number')
        .map((item) => item!.index as number)
    );
    const verification =
      objectValue(rawVerification) ??
      (Array.isArray(rawVerification)
        ? objectValue(
            rawVerification.find((item) => {
              const candidate = objectValue(item);
              return (
                candidate &&
                objectValue(candidate.verify) &&
                (unknownIndexes.size === 0 || unknownIndexes.has(candidate.index as number))
              );
            })
          )
        : undefined);
    if (verification) {
      const rawArgs = objectValue(verification.verify) ? verification : undefined;
      const verify = rawArgs ? objectValue(rawArgs.verify) : objectValue(verification.verify);
      const collection = rawArgs?.collection ?? verification.collection;
      const id = rawArgs?.id ?? verification.id;
      if (
        typeof collection !== 'string' ||
        typeof id !== 'string' ||
        !verify ||
        !['create', 'update', 'delete'].includes(String(verify.operation))
      )
        return {
          kind: 'ask_user',
          reason: 'Исход записи неизвестен; выясните текущее состояние в BPMSoft перед любым повтором.',
          requires_user_input: true,
        };
      const safeVerify =
        verify.operation === 'delete'
          ? { operation: 'delete' }
          : verify.expected && typeof verify.expected === 'object' && !Array.isArray(verify.expected)
            ? { operation: verify.operation, expected: verify.expected }
            : undefined;
      if (!safeVerify)
        return {
          kind: 'ask_user',
          reason: 'Исход записи неизвестен; выясните текущее состояние в BPMSoft перед любым повтором.',
          requires_user_input: true,
        };
      const args = removeSensitiveKeys({ collection, id, verify: safeVerify }) as Record<string, unknown>;
      const cleanVerify = objectValue(args.verify);
      const expected = cleanVerify && objectValue(cleanVerify.expected);
      if (
        safeVerify.operation !== 'delete' &&
        JSON.stringify(expected) !== JSON.stringify(safeVerify.expected)
      )
        return {
          kind: 'ask_user',
          reason:
            'Проверка результата содержит чувствительные поля; выполните её вручную и учтите, что часть ожидаемых значений скрыта.',
          requires_user_input: true,
        };
      if (safeVerify.operation !== 'delete' && (!expected || Object.keys(expected).length === 0))
        return {
          kind: 'ask_user',
          reason:
            'Исход записи неизвестен; найдите безопасный способ проверить её текущее состояние перед любым повтором.',
          requires_user_input: true,
        };
      if (JSON.stringify(args).length > 12_000)
        return {
          kind: 'ask_user',
          reason:
            'Данные для проверки слишком велики для передачи. Сузьте ожидаемые поля при проверке результата.',
          requires_user_input: true,
        };
      return {
        kind: 'verify',
        tool: 'bpm_get_record',
        arguments: args,
        reason: `Исход записи неизвестен${typeof rawArgs?.index === 'number' ? ` для строки ${rawArgs.index}` : ''}; сначала проверьте текущее состояние в BPMSoft.`,
        requires_user_input: false,
      };
    }
    return {
      kind: 'ask_user',
      reason: 'Исход записи неизвестен; выясните текущее состояние в BPMSoft перед любым повтором.',
      requires_user_input: true,
    };
  }
  if (
    structured.ready === false ||
    (Array.isArray(structured.blockers) && structured.blockers.length > 0) ||
    (Array.isArray(structured.missing_fields) && structured.missing_fields.length > 0) ||
    (Array.isArray(structured.clarifications) && structured.clarifications.length > 0)
  )
    return {
      kind: 'ask_user',
      reason: 'Запись не готова к выполнению; разрешите перечисленные blockers или уточнения.',
      requires_user_input: true,
    };
  if (structured.requires_confirmation === true && typeof structured.confirmation_token === 'string') {
    const allowed = allowedInputKeys(inputSchema);
    if (!allowed.has('confirm') || !allowed.has('confirmation_token')) return undefined;
    const source = objectValue(structured.normalized_args) ?? {};
    const artifactFields = [
      'collection',
      'id',
      'ids',
      'data',
      'updates',
      'operations',
      'criteria',
      'filter',
      'join',
      'expected_count',
      'expected_etag',
      'steps',
      'process_name',
      'parameters',
      'element_uid',
      'file_name',
      'field',
      'record_id',
      'file_id',
      'mode',
      'continue_on_error',
    ];
    const plannedArgs = Object.fromEntries(
      artifactFields
        .filter((key) => allowed.has(key) && (Object.hasOwn(source, key) || Object.hasOwn(structured, key)))
        .map((key) => [key, Object.hasOwn(source, key) ? source[key] : structured[key]])
    );
    const args = removeSensitiveKeys(plannedArgs) as Record<string, unknown>;
    // Never turn a prepared operation into a different operation by redacting
    // fields from its confirmation payload.
    if (JSON.stringify(args) !== JSON.stringify(plannedArgs))
      return {
        kind: 'ask_user',
        reason: 'План содержит чувствительные данные; проверьте и подтвердите его вручную.',
        requires_user_input: true,
      };
    args.confirm = true;
    args.confirmation_token = structured.confirmation_token;
    if (allowed.has('dry_run') && 'dry_run' in args) args.dry_run = false;
    if (!inputArgsMatchSchema(inputSchema, args)) return undefined;
    return {
      kind: 'confirm',
      tool: name,
      arguments: args,
      confirmation: {
        required: true,
        prompt: 'Покажите план пользователю и дождитесь его явного подтверждения.',
      },
      reason: 'Операция подготовлена; покажите план пользователю и дождитесь явного подтверждения.',
      requires_user_input: true,
    };
  }
  const clarification = structured.code === 'lookup_ambiguous' || structured.code === 'match_ambiguous';
  if (clarification)
    return {
      kind: 'ask_user',
      reason: 'Нужно уточнить значение, чтобы выбрать ровно одну запись.',
      requires_user_input: true,
    };
  const safeIndexes = Array.isArray(structured.safe_retry_indices) ? structured.safe_retry_indices : [];
  const retryArgs = objectValue(structured.retry_args);
  if (retryArgs && safeIndexes.length) {
    if (!(inputSchema instanceof z.ZodType) && (!inputSchema || typeof inputSchema !== 'object'))
      return undefined;
    const allowed = allowedInputKeys(inputSchema);
    const safePreview: Record<string, unknown> = { ...retryArgs };
    if (allowed.has('confirm')) safePreview.confirm = false;
    if (allowed.has('dry_run')) safePreview.dry_run = true;
    if (!inputArgsMatchSchema(inputSchema, safePreview)) return undefined;
    return {
      kind: 'retry_preview',
      tool: name,
      arguments: safePreview,
      reason: 'Подготовьте превью только для строк, явно отмеченных безопасными для повтора.',
      requires_user_input: false,
    };
  }
  if (
    (name === 'bpm_get_records' || name === 'bpm_search_records') &&
    structured.has_more === true &&
    typeof structured.cursor === 'string'
  ) {
    const args = { cursor: structured.cursor };
    if (!inputArgsMatchSchema(inputSchema, args)) return undefined;
    return {
      kind: 'next_page',
      tool: name,
      arguments: args,
      reason: 'Доступна следующая страница результатов.',
      requires_user_input: false,
    };
  }
  const explicitCompletion =
    structured.state === 'completed' ||
    structured.state === 'succeeded' ||
    (Array.isArray(structured.outcomes) &&
      structured.outcomes.length > 0 &&
      structured.outcomes.every((item) =>
        ['completed', 'succeeded'].includes(String(objectValue(item)?.state))
      )) ||
    (typeof structured.total === 'number' &&
      structured.succeeded === structured.total &&
      structured.failed === 0);
  if (explicitCompletion)
    return { kind: 'complete', reason: 'Операция явно завершилась успешно.', requires_user_input: false };
  return undefined;
}

function withNextAction(
  name: string,
  result: CallToolResult,
  inputSchema?: unknown,
  readOnly = false
): CallToolResult {
  const structured = parseOutputEnvelope(result);
  if (!structured) return result;
  if (!result.structuredContent && structured.success === false)
    result = { ...result, structuredContent: structured, isError: true };
  if (structured.next_action) return result;
  const nextAction = inferNextAction(name, structured, inputSchema);
  if (!nextAction) return result;
  const enriched = {
    ...result,
    structuredContent: { ...structured, next_action: nextAction },
  } as CallToolResult;
  const actionText = `Next action: ${JSON.stringify(nextAction)}`;
  const content = result.isError
    ? [...(result.content ?? []), { type: 'text' as const, text: actionText }]
    : (result.content ?? []).map((part, index) =>
        part.type === 'text' && index === 0 ? { ...part, text: `${part.text}\n\n${actionText}` } : part
      );
  const finalContent = content.some((part) => part.type === 'text')
    ? content
    : [...content, { type: 'text' as const, text: actionText }];
  const complete = {
    ...enriched,
    content: finalContent,
    ...(structured.success === false ? { isError: true } : {}),
  };
  if (
    readOnly &&
    (serializedResultBytes(complete) > READ_RESULT_BYTE_LIMIT ||
      serializedResultBytesAfterTextLimit(complete) > READ_RESULT_BYTE_LIMIT)
  )
    return result;
  return complete;
}

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
 * Это отдельный лимит представления текста. Для readOnlyHint=true полный результат
 * дополнительно проверяется по JSON-байтам, включая structuredContent.
 */
export const CHARACTER_LIMIT = READ_RESULT_TEXT_CHARACTER_LIMIT;

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
  response_bytes: z.number().int().nonnegative().optional(),
  response_limit_bytes: z.number().int().positive().optional(),
  next_action: nextActionSchema.optional(),
});

function outputSchemaWithErrors(schema: unknown) {
  const baseSuccess = schema instanceof z.ZodType ? schema : z.strictObject(schema as z.ZodRawShape);
  const success =
    baseSuccess instanceof z.ZodObject
      ? baseSuccess.safeExtend({ next_action: nextActionSchema.optional() })
      : baseSuccess;
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
  return applyResultTextLimit(result);
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
  const result = outcome as
    | {
        structuredContent?: Record<string, unknown>;
        content?: Array<{ type?: string; text?: string }>;
      }
    | undefined;
  const structured = result?.structuredContent;
  if (structured && typeof structured.error === 'string')
    return summarize(structured.httpStatus, structured.code, structured.error, structured.details);
  const texts =
    result?.content?.filter((part) => part.type === 'text' && typeof part.text === 'string') ?? [];
  for (const part of texts) {
    try {
      const body = JSON.parse(part.text!) as Record<string, unknown> | null;
      if (body && typeof body === 'object' && 'error' in body)
        return summarize(body.httpStatus, body.code, body.error, body.details);
    } catch {
      // Human-readable text is used below when there is no error envelope.
    }
  }
  return summarize(undefined, undefined, texts.find((part) => !part.text!.startsWith('operation_id:'))?.text);
}

/**
 * Оборачивает обработчики инструментов сервера замером времени.
 * Возвращает тот же экземпляр — вызывать до регистрации инструментов.
 */
export function instrumentTools(server: McpServer, services?: ServiceContainer): McpServer {
  const target = server as unknown as {
    registerTool: (name: string, config: unknown, handler: ToolHandler) => unknown;
    __instrumented?: boolean;
  };
  if (target.__instrumented) return server;

  const original = target.registerTool.bind(target);

  target.registerTool = (name: string, config: unknown, handler: ToolHandler) => {
    const cfg = config as
      | { inputSchema?: unknown; outputSchema?: unknown; annotations?: { readOnlyHint?: boolean } }
      | undefined;
    const readOnly = cfg?.annotations?.readOnlyHint === true;
    const output = cfg?.outputSchema ? outputSchemaWithErrors(cfg.outputSchema) : undefined;
    const wrapped = async (...args: unknown[]) => {
      const started = Date.now();
      try {
        const execute = async (): Promise<CallToolResult> => {
          const rawResult = (await handler(...args)) as CallToolResult;
          const result = withNextAction(name, rawResult, cfg?.inputSchema, readOnly);
          if (output && !result.isError) {
            const parsed = await output.success.safeParseAsync(result.structuredContent);
            if (!parsed.success)
              throw new Error(`Output validation error: Tool ${name}: ${parsed.error.message}`);
          }
          return result;
        };
        const result =
          readOnly && services
            ? await runWithReadBudget(
                {
                  timeoutMs: services.config?.read_budget_timeout ?? 120_000,
                  maxRequests: services.config?.read_budget_requests ?? 100,
                  maxBytes: services.config?.read_budget_bytes ?? 64 * 1024 * 1024,
                },
                execute
              )
            : services?.config?.journal_root && name !== 'bpm_init' && name !== 'bpm_download_file'
              ? await withOperationJournal(services, name, args[0], execute)
              : await execute();
        // Reject the original read result, even if legacy text clipping could make it fit.
        // Write/partial receipts must retain their structured outcomes after execution.
        const budgeted = readOnly ? enforceReadResultBudget(result) : result;
        const rendered = limitResultText(budgeted);
        // Clipping adds a notice, so the final result needs the same complete budget.
        const emitted = readOnly ? enforceReadResultBudget(rendered) : rendered;
        const isError = Boolean((emitted as { isError?: boolean } | undefined)?.isError);
        const ms = Date.now() - started;
        record(name, ms, isError);
        console.error(`[tool] ${name} ${ms}ms ${isError ? `error ${describeToolError(emitted)}` : 'ok'}`);
        return emitted;
      } catch (error) {
        const ms = Date.now() - started;
        record(name, ms, true);
        console.error(`[tool] ${name} ${ms}ms threw ${describeToolError(error)}`);
        if (error instanceof BpmApiError) {
          let failure: Record<string, unknown> = { ...formatToolError(error) };
          const nextAction = inferNextAction(name, failure);
          if (nextAction) failure = { ...failure, next_action: nextAction };
          return {
            content: [{ type: 'text', text: JSON.stringify(failure) }],
            structuredContent: failure,
            isError: true,
          };
        }
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
