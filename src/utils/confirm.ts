import * as z from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const confirmParam = z
  .boolean()
  .optional()
  .describe(
    'Подтверждение удаления. Без confirm=true запрос вернёт описание того, что будет удалено, но ничего не удалит. Передайте confirm=true после того, как пользователь явно согласился.'
  );

export function confirmationRequired(params: { confirm?: boolean }): boolean {
  return params.confirm !== true;
}

export function previewIdList(ids: string[], cap: number = 20): string {
  if (ids.length <= cap) return ids.join(', ');
  const shown = ids.slice(0, cap).join(', ');
  return `${shown}, и ещё ${ids.length - cap}`;
}

export function confirmationResponse(
  toolName: string,
  descriptionLines: string[],
  structuredExtra: Record<string, unknown>
): CallToolResult {
  const text = [...descriptionLines, '', `Для подтверждения повторите вызов ${toolName} с параметром confirm=true.`].join(
    '\n'
  );

  return {
    content: [{ type: 'text', text }],
    structuredContent: { requires_confirmation: true, ...structuredExtra },
  };
}
