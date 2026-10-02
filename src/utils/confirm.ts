import * as z from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createHash, randomUUID } from 'node:crypto';
import { getAuthCacheScope } from '../auth/request-context.js';
import type { ServiceContainer } from '../tools/init-tool.js';
import { BpmApiError } from './errors.js';

export const confirmParam = z
  .boolean()
  .optional()
  .describe(
    'Подтверждение операции. Первый вызов возвращает предварительный просмотр. Для выполнения проверенного плана передайте confirm=true вместе с confirmation_token; действие должно соответствовать запросу пользователя.'
  );

export const confirmationTokenParam = z
  .string()
  .optional()
  .describe(
    'Токен предварительного просмотра. Для выполнения передайте вместе с confirm=true; токен связан с подключением, пользователем и точным составом операции, действует 10 минут и используется один раз.'
  );

interface ConfirmationPlan {
  scope: string;
  fingerprint: string;
  expiresAt: number;
}

const plans = new WeakMap<ServiceContainer, Map<string, ConfirmationPlan>>();

/** Stable ordering matters when comparing JSON payloads from successive calls. */
export function operationFingerprint(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, val]) => [key, canonical(val)])
      );
    }
    return item;
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

export function operationScope(services: ServiceContainer): string {
  return operationFingerprint({
    instance: services.config?.bpmsoft_url,
    user: getAuthCacheScope() || services.config?.username,
  });
}

export function createConfirmationPlan(services: ServiceContainer, operation: unknown): string {
  let store = plans.get(services);
  if (!store) {
    store = new Map();
    plans.set(services, store);
  }
  const now = Date.now();
  for (const [token, plan] of store) if (plan.expiresAt <= now) store.delete(token);
  if (store.size >= 1000)
    throw new BpmApiError('Слишком много неподтверждённых операций. Дождитесь истечения старых планов.', 429);
  const token = randomUUID();
  store.set(token, {
    scope: operationScope(services),
    fingerprint: operationFingerprint(operation),
    expiresAt: now + 10 * 60_000,
  });
  return token;
}

export function consumeConfirmationPlan(
  services: ServiceContainer,
  token: string | undefined,
  operation: unknown
): void {
  const store = plans.get(services);
  const plan = token ? store?.get(token) : undefined;
  if (!plan || plan.expiresAt <= Date.now()) {
    throw new BpmApiError(
      'Подтверждение отсутствует, уже использовано или истекло. Получите новый предварительный просмотр.',
      400
    );
  }
  if (plan.scope !== operationScope(services) || plan.fingerprint !== operationFingerprint(operation)) {
    throw new BpmApiError(
      'Операция или записи изменились после предварительного просмотра. Получите и подтвердите новый план.',
      409
    );
  }
  store!.delete(token!);
}

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
  const text = [
    ...descriptionLines,
    '',
    `Для подтверждения повторите вызов ${toolName} с параметром confirm=true${structuredExtra.confirmation_token ? ' и полученным confirmation_token' : ''}.`,
  ].join('\n');

  return {
    content: [{ type: 'text', text }],
    structuredContent: { requires_confirmation: true, code: 'confirm_required', ...structuredExtra },
  };
}
