/**
 * Error handling utilities for BPMSoft MCP Server
 *
 * Formats errors into structured, informative messages with:
 *   - human-readable text (`error`, `details`)
 *   - "did you mean?" suggestions (`suggestions`)
 *   - actionable next steps for the LLM agent (`next_steps`)
 */

import type { ToolError, ODataErrorResponse } from '../types/index.js';

export class BpmApiError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number,
    public readonly collection?: string,
    public readonly details?: string,
    public readonly suggestions?: string[],
    public readonly nextSteps?: string[]
  ) {
    super(message);
    this.name = 'BpmApiError';
  }

  toToolError(): ToolError {
    return {
      success: false,
      error: this.message,
      httpStatus: this.httpStatus,
      collection: this.collection,
      details: this.details,
      suggestions: this.suggestions,
      next_steps: this.nextSteps ?? defaultNextSteps(this.httpStatus, this.collection),
    };
  }

  toString(): string {
    const parts = [`Ошибка: ${this.message}`, `HTTP статус: ${this.httpStatus}`];
    if (this.collection) parts.push(`Коллекция: ${this.collection}`);
    if (this.details) parts.push(`Детали: ${this.details}`);
    if (this.suggestions?.length) parts.push(`Похоже на: ${this.suggestions.join(', ')}`);
    return parts.join('\n');
  }
}

export class AuthenticationError extends BpmApiError {
  constructor(message: string, details?: string) {
    super(message, 401, undefined, details, undefined, [
      'Проверьте корректность логина/пароля и URL приложения.',
      'Попробуйте перезапустить bpm_init с актуальными учётными данными.',
    ]);
    this.name = 'AuthenticationError';
  }
}

export class NotFoundError extends BpmApiError {
  constructor(collection: string, id?: string) {
    const msg = id
      ? `Запись не найдена: ${collection}(${id})`
      : `Коллекция не найдена: ${collection}`;
    const next: string[] = id
      ? [
          `Возможно, ID устарел. Найдите актуальную запись: bpm_lookup_value(${collection}, Name, "<имя из контекста>")`,
          `Или проверьте список через bpm_get_records(${collection}, filter="...").`,
        ]
      : [
          'Запросите список доступных коллекций: bpm_get_collections.',
          'Имена в BPMSoft чувствительны к регистру (Contact, Account и т.д.).',
        ];
    super(msg, 404, collection, undefined, undefined, next);
    this.name = 'NotFoundError';
  }
}

export class LookupResolutionError extends Error {
  public readonly suggestions?: string[];
  public readonly nextSteps?: string[];

  constructor(
    public readonly field: string,
    public readonly searchValue: string,
    public readonly matchCount: number,
    public readonly candidates: Array<{ id: string; displayValue: string }>
  ) {
    const msg =
      matchCount === 0
        ? `Lookup "${field}": значение "${searchValue}" не найдено`
        : `Lookup "${field}": найдено ${matchCount} совпадений для "${searchValue}", требуется уточнение`;
    super(msg);
    this.name = 'LookupResolutionError';

    if (matchCount === 0) {
      this.nextSteps = [
        `Попробуйте bpm_lookup_value с fuzzy=true — он также найдёт неточные совпадения через contains().`,
        `Если не уверены в названии справочника — используйте bpm_get_enum_values для просмотра всех допустимых значений.`,
      ];
    } else {
      this.suggestions = candidates.slice(0, 5).map((c) => `${c.displayValue} (${c.id})`);
      this.nextSteps = [
        `Уточните значение, чтобы оно совпало точно (case-sensitive).`,
        `Или передайте UUID одного из кандидатов напрямую вместо текста.`,
      ];
    }
  }
}

/** Используется при попытке сослаться на неизвестное поле, имя коллекции или подпись. */
export class UnknownFieldError extends BpmApiError {
  constructor(
    public readonly fieldQuery: string,
    public readonly collectionName: string,
    suggestions: string[]
  ) {
    const msg = `Поле "${fieldQuery}" не найдено в коллекции ${collectionName}`;
    super(msg, 400, collectionName, undefined, suggestions, [
      `Запросите схему коллекции: bpm_get_schema(${collectionName}).`,
      `Найдите поле по русскому названию: bpm_find_field("${fieldQuery}", "${collectionName}").`,
    ]);
    this.name = 'UnknownFieldError';
  }
}

export class UnknownCollectionError extends BpmApiError {
  constructor(public readonly collectionQuery: string, suggestions: string[]) {
    const msg = `Коллекция "${collectionQuery}" не найдена`;
    super(msg, 404, collectionQuery, undefined, suggestions, [
      `Запросите список коллекций: bpm_get_collections${suggestions.length ? `(pattern="${collectionQuery.slice(0, 4)}")` : ''}.`,
      `Имена коллекций чувствительны к регистру.`,
    ]);
    this.name = 'UnknownCollectionError';
  }
}

export function parseODataError(body: unknown): string | undefined {
  if (body && typeof body === 'object' && 'error' in body) {
    const errorBody = body as ODataErrorResponse;
    return errorBody.error?.message;
  }
  return undefined;
}

/**
 * Format any error into a consistent ToolError.
 * - Preserves suggestions and next_steps from BpmApiError subclasses.
 * - For LookupResolutionError, surfaces candidates as suggestions.
 * - For generic Error, attaches generic next_steps when possible.
 */
export function formatToolError(error: unknown, collection?: string): ToolError {
  if (error instanceof BpmApiError) {
    const tool = error.toToolError();
    if (collection && !tool.collection) tool.collection = collection;
    return tool;
  }

  if (error instanceof LookupResolutionError) {
    return {
      success: false,
      error: error.message,
      collection,
      details:
        error.matchCount > 1
          ? `Кандидаты: ${error.candidates.map((c) => `"${c.displayValue}" (${c.id})`).join(', ')}`
          : undefined,
      suggestions: error.suggestions,
      next_steps: error.nextSteps,
    };
  }

  if (error instanceof Error) {
    return {
      success: false,
      error: error.message,
      collection,
      next_steps: defaultNextSteps(undefined, collection),
    };
  }

  return {
    success: false,
    error: String(error),
    collection,
    next_steps: defaultNextSteps(undefined, collection),
  };
}

function defaultNextSteps(httpStatus?: number, collection?: string): string[] | undefined {
  if (httpStatus === 401 || httpStatus === 403) {
    return [
      'Запросите у пользователя проверить срок действия учётной записи.',
      'Если ошибка повторяется — повторно вызовите bpm_init с актуальными данными.',
    ];
  }
  if (httpStatus === 400 && collection) {
    return [
      `Проверьте схему коллекции: bpm_get_schema(${collection}).`,
      'OData $filter чувствителен к синтаксису: сравнения через eq/ne/gt/ge/lt/le, строки в одинарных кавычках, навигация через "/", даты в ISO 8601.',
      'Используйте bpm_search_records с criteria-DSL — он сам соберёт корректный $filter.',
    ];
  }
  if (httpStatus === 412) {
    return ['Сервер отклонил предусловие. Проверьте обязательные поля и совместимость значений.'];
  }
  if (httpStatus === 429 || httpStatus === 503) {
    return ['Сервер сообщил о перегрузке. Подождите несколько секунд и повторите запрос.'];
  }
  return undefined;
}
