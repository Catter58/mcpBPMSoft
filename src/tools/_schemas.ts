/**
 * Shared zod fragments for tool outputSchema declarations.
 *
 * Каждый инструмент декларирует outputSchema в registerTool — SDK валидирует
 * structuredContent успешных ответов. Общие фрагменты (пагинация, notes о
 * fuzzy-lookup, confirm-превью) живут здесь, чтобы контракт был единым.
 */

import * as z from 'zod';

/** Общий контракт пагинации списочных ответов. */
export const paginationShape = {
  count: z.number().int().describe('Записей в этом ответе'),
  total_count: z.number().int().optional().describe('Общее число записей (если известно)'),
  has_more: z.boolean().describe('Есть ли продолжение'),
  cursor: z.string().optional().describe('Курсор следующей страницы'),
};

export const recordShape = z.record(z.string(), z.unknown());

/** Пометка о неточно (fuzzy) разрешённом lookup-поле. */
export const resolvedLookupNoteShape = z.object({
  field: z.string(),
  input: z.string(),
  matched_value: z.string(),
  match_type: z.enum(['contains', 'core']),
});

export const lookupCandidateShape = z.object({
  id: z.string(),
  displayValue: z.string(),
  score: z.number().optional(),
  additionalInfo: z.record(z.string(), z.unknown()).optional(),
});

/** Поля confirm-превью (двухшаговое подтверждение деструктивных операций). */
export const confirmShape = {
  requires_confirmation: z.boolean().optional().describe('true — это превью, ничего не изменено'),
  code: z.string().optional().describe('Машинный код состояния (confirm_required и т.п.)'),
};
