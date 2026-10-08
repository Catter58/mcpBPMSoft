/**
 * Shared zod fragments for tool outputSchema declarations.
 *
 * Каждый инструмент декларирует outputSchema в registerTool — SDK валидирует
 * structuredContent успешных ответов. Общие фрагменты (пагинация, notes о
 * fuzzy-lookup, confirm-превью) живут здесь, чтобы контракт был единым.
 */

import * as z from 'zod';
import type { Criterion } from '../utils/filter-compiler.js';

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

/** Exact record targeting by one or more business-key fields. */
export const matchByFieldSchema = z
  .object({ field: z.string().min(1).max(128), value: z.unknown() })
  .strict();
export const matchBySchema = z
  .array(matchByFieldSchema)
  .min(1)
  .max(8)
  .describe(
    'Точный бизнес-ключ: все поля должны совпасть одновременно; неоднозначный результат блокирует запись.'
  );
export const matchedByShape = z.object({
  fields: z.array(z.object({ field: z.string(), caption: z.string(), type: z.string() })),
  values: z.record(z.string(), z.unknown()),
});
export const valueOriginShape = z.object({
  field: z.string(),
  source: z.enum(['caller', 'normalized', 'lookup', 'current_user', 'computed', 'platform_default']),
  observed: z.boolean(),
  value: z.unknown().optional(),
});

export type MatchByField = z.infer<typeof matchByFieldSchema>;

/** Поля confirm-превью (двухшаговое подтверждение деструктивных операций). */
export const confirmShape = {
  requires_confirmation: z.boolean().optional().describe('true — это превью, ничего не изменено'),
  code: z.string().optional().describe('Машинный код состояния (confirm_required и т.п.)'),
  confirmation_token: z.string().optional(),
  concurrency_protection: z.enum(['snapshot_only', 'etag']).optional(),
};

export const confirmationTokenParam = z
  .string()
  .optional()
  .describe('Одноразовый токен из предварительного просмотра той же операции.');

/** Критерий criteria-DSL: компилируется сервером в $filter (см. utils/filter-compiler.ts). */
const criterionLeafSchema = z
  .object({
    field: z
      .string()
      .optional()
      .describe(
        'Имя поля, caption или путь навигации (например "Account.City"). Для открыт/закрыт/выиграна/проиграна можно не указывать — сервер найдёт поле состояния сам'
      ),
    op: z
      .string()
      .describe(
        'Оператор: равно/eq, не равно/ne, больше/gt, больше или равно/ge, меньше/lt, меньше или равно/le, содержит/contains (регистронезависимо), не содержит/not_contains, начинается с/startswith, заканчивается на/endswith, в списке/in, пусто/is_null, не пусто/is_not_null, за последние N дней/in_last_days, за последние N часов/in_last_hours, между/between, похоже на/similar_to, exists/not_exists только для коллекционной навигации из метаданных в OData v4; сегодня/вчера/завтра/на этой неделе/в этом месяце/в этом квартале/в этом году; состояние записи — открыт/open, закрыт/closed, выиграна/won, проиграна/lost (по флагам справочника статуса/стадии). Для lookup на контакт/пользователя value="я" подставляет текущего пользователя. Логические группы задаются как {and:[...]}, {or:[...]} и {not:...}; null следует семантике OData, для явной проверки используйте is_null/is_not_null.'
      ),
    value: z
      .unknown()
      .optional()
      .describe('Значение (отсутствует для is_null/is_not_null и календарных операторов)'),
    value_to: z.unknown().optional().describe('Верхняя граница для оператора between'),
  })
  .strict();

/** Group children stay compact in MCP's advertised schema; compileFilter validates the recursive tree. */
export const criterionSchema = z
  .union([
    criterionLeafSchema,
    z.object({ and: z.array(z.unknown()).min(1).max(100) }).strict(),
    z.object({ or: z.array(z.unknown()).min(1).max(100) }).strict(),
    z.object({ not: z.unknown() }).strict(),
  ])
  .describe(
    'Leaf criterion or nested {and:[...]}, {or:[...]}, {not:...} group; nesting, operators, and node limits are validated by the server.'
  ) as unknown as z.ZodType<Criterion>;

/** Что сервер заполнил и пересчитал в строках заказа/счёта и сумме родителя (workflows/line-items). */
export const lineItemsNotesShape = z
  .array(z.string())
  .optional()
  .describe('Что сервер заполнил и пересчитал в строках заказа/счёта и сумме родителя');
