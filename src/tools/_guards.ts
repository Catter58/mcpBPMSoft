/**
 * Shared helpers for MCP tools — init guard and standardized error/result formatting.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceContainer } from './init-tool.js';
import type { ResolvedLookupNote } from '../lookup/lookup-resolver.js';

export const NOT_INITIALIZED_RESULT: CallToolResult = {
  content: [
    {
      type: 'text',
      text: JSON.stringify(
        {
          success: false,
          code: 'not_initialized',
          error: 'Сервер не инициализирован. Сначала вызовите bpm_init с параметрами подключения.',
          next_steps: ['Вызовите bpm_init с URL, логином и паролем BPMSoft.'],
        },
        null,
        2
      ),
    },
  ],
  isError: true,
};

export function notInitialized(): CallToolResult {
  return NOT_INITIALIZED_RESULT;
}

/**
 * Wrap a handler so that if services are not initialized it returns the
 * standardized error without entering the handler body. The handler still
 * receives the (now guaranteed non-empty) container.
 */
export function withInit<TArgs, TExtra>(
  services: ServiceContainer,
  handler: (args: TArgs, extra: TExtra) => Promise<CallToolResult>
): (args: TArgs, extra: TExtra) => Promise<CallToolResult> {
  return async (args, extra) => {
    if (!services.initialized) return notInitialized();
    return handler(args, extra);
  };
}

/**
 * Build a tool result from a plain text body, preserving isError.
 */
export function textResult(text: string, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    isError,
  };
}

/**
 * Build a tool result that includes both text and structured content
 * (clients on MCP SDK >= 1.x can read structuredContent for richer UX).
 */
export function structuredResult(text: string, structured: Record<string, unknown>, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent: structured,
    isError,
  };
}

/** Человекочитаемая строка о fuzzy-резолвах lookup-полей (null, если их не было). */
export function lookupNotesText(notes: ResolvedLookupNote[]): string | null {
  if (notes.length === 0) return null;
  const parts = notes.map((n) => `${n.field}: "${n.input}" → "${n.matchedValue}"`);
  return `Неточно разрешены lookup-поля: ${parts.join('; ')}`;
}

/** snake_case-представление notes для structuredContent (resolved_lookups). */
export function lookupNotesStructured(
  notes: ResolvedLookupNote[]
): Array<{ field: string; input: string; matched_value: string; match_type: 'contains' | 'core' }> {
  return notes.map((n) => ({
    field: n.field,
    input: n.input,
    matched_value: n.matchedValue,
    match_type: n.matchType,
  }));
}
