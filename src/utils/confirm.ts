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
  freshness?: {
    intents: string[];
    snapshots: Array<{ index: number; id: string; values: Record<string, unknown> }>;
  };
}

export interface ConfirmationFreshness {
  intent: unknown;
  acceptedIntents?: unknown[];
  snapshots: Array<{ index: number; id: string; values: Record<string, unknown> }>;
}
export interface ConfirmationConflict {
  changed: Array<{
    index: number;
    id: string;
    fields: Array<{ field: string; before: unknown; current: unknown }>;
  }>;
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
    .update(JSON.stringify(canonical(value)) ?? '"__undefined__"')
    .digest('hex');
}

export function operationScope(services: ServiceContainer): string {
  return operationFingerprint({
    instance: services.config?.bpmsoft_url,
    user: getAuthCacheScope() || services.config?.username,
  });
}

export function createConfirmationPlan(
  services: ServiceContainer,
  operation: unknown,
  freshness?: ConfirmationFreshness
): string {
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
    ...(freshness
      ? {
          freshness: {
            intents: [freshness.intent, ...(freshness.acceptedIntents ?? [])].map(operationFingerprint),
            snapshots: structuredClone(freshness.snapshots),
          },
        }
      : {}),
  });
  return token;
}

export function consumeConfirmationPlan(
  services: ServiceContainer,
  token: string | undefined,
  operation: unknown,
  freshness?: ConfirmationFreshness
): ConfirmationConflict | undefined {
  const store = plans.get(services);
  const plan = token ? store?.get(token) : undefined;
  if (!plan || plan.expiresAt <= Date.now()) {
    throw new BpmApiError(
      'Подтверждение отсутствует, уже использовано или истекло. Получите новый предварительный просмотр.',
      400
    );
  }
  if (plan.scope !== operationScope(services)) {
    throw new BpmApiError(
      'Подключение или пользователь изменились после предварительного просмотра. Получите новый план.',
      409
    );
  }
  if (plan.fingerprint !== operationFingerprint(operation)) {
    if (
      !plan.freshness ||
      !freshness ||
      !plan.freshness.intents.includes(operationFingerprint(freshness.intent))
    )
      throw new BpmApiError(
        'Операция или записи изменились после предварительного просмотра. Получите и подтвердите новый план.',
        409
      );
    const old = new Map(plan.freshness.snapshots.map((snapshot) => [snapshot.index, snapshot]));
    if (
      freshness.snapshots.length !== plan.freshness.snapshots.length ||
      freshness.snapshots.some((snapshot) => old.get(snapshot.index)?.id !== snapshot.id)
    )
      throw new BpmApiError(
        'Целевые записи изменились после предварительного просмотра. Получите новый план.',
        409
      );
    const changed = freshness.snapshots.flatMap((snapshot) => {
      const prior = old.get(snapshot.index)!;
      const fields = [...new Set([...Object.keys(prior.values), ...Object.keys(snapshot.values)])]
        .filter(
          (field) =>
            Object.hasOwn(prior.values, field) !== Object.hasOwn(snapshot.values, field) ||
            operationFingerprint(prior.values[field]) !== operationFingerprint(snapshot.values[field])
        )
        .map((field) => ({ field, before: prior.values[field], current: snapshot.values[field] }));
      return fields.length ? [{ index: snapshot.index, id: snapshot.id, fields }] : [];
    });
    if (!changed.length)
      throw new BpmApiError(
        'Операция изменилась после предварительного просмотра. Получите новый план.',
        409
      );
    store!.delete(token!);
    return { changed };
  }
  store!.delete(token!);
  return undefined;
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
