import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** Budget for the complete JSON result of an explicitly read-only tool. */
export const READ_RESULT_BYTE_LIMIT = 64 * 1024;
export const READ_RESULT_TEXT_CHARACTER_LIMIT = 25_000;

/** Counts both representations, content blocks, metadata and JSON/UTF-8 overhead. */
export function serializedResultBytes(result: unknown): number {
  return Buffer.byteLength(JSON.stringify(result), 'utf8');
}

/** Measure the exact result after instrumentation applies its text clipping rule. */
export function serializedResultBytesAfterTextLimit(result: unknown): number {
  return serializedResultBytes(limitResultText(result));
}

/** Shared with instrumentation so read-page budgeting matches the emitted envelope. */
export function limitResultText(result: unknown): unknown {
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
  if (!Array.isArray(content)) return result;
  const total = content.reduce((n, part) => n + (part.type === 'text' ? (part.text?.length ?? 0) : 0), 0);
  if (total <= READ_RESULT_TEXT_CHARACTER_LIMIT) return result;
  let left = READ_RESULT_TEXT_CHARACTER_LIMIT;
  const trimmed = content.map((part) => {
    if (part.type !== 'text' || typeof part.text !== 'string') return part;
    const text = part.text.slice(0, Math.max(0, left));
    left -= text.length;
    return { ...part, text };
  });
  trimmed.push({
    type: 'text',
    text:
      `\n[Ответ обрезан: ${READ_RESULT_TEXT_CHARACTER_LIMIT} из ${total} символов. Сузьте выборку — фильтр, top, select — ` +
      'полные данные есть в structuredContent.]',
  });
  return { ...(result as object), content: trimmed };
}

/** Rejects the whole result: slicing it here would invalidate counts and cursors. */
export function enforceReadResultBudget(result: unknown): unknown {
  const responseBytes = serializedResultBytes(result);
  if (responseBytes <= READ_RESULT_BYTE_LIMIT) return result;

  const failure = {
    success: false,
    code: 'response_too_large',
    error: `Ответ не возвращён: ${responseBytes} байт превышают лимит ${READ_RESULT_BYTE_LIMIT} байт. Это отказ, а не неполная выборка.`,
    safe_to_retry: true,
    response_bytes: responseBytes,
    response_limit_bytes: READ_RESULT_BYTE_LIMIT,
    next_steps: [
      'Не повторяйте тот же запрос. Сузьте filter и перечислите нужные поля в select. При auto_paginate=true уменьшите max_records или отключите auto_paginate; иначе уменьшите top.',
      'Для количества записей используйте bpm_count_records вместо выгрузки коллекции.',
      'Для сводки, группировки и сумм используйте bpm_aggregate или bpm_aggregate_records.',
    ],
  };
  const rejected: CallToolResult = {
    content: [{ type: 'text', text: JSON.stringify(failure) }],
    structuredContent: failure,
    isError: true,
  };
  return rejected;
}
