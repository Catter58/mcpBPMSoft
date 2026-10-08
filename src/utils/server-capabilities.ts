/**
 * Возможности конкретного инстанса BPMSoft, выясняемые в бою.
 *
 * Проверенные возможности повторно используются, чтобы не тратить запросы
 * на заведомо неподдерживаемые конструкции. Поддержка batch ограничена сроком
 * жизни и контекстом подключения, пользователя и коллекции.
 *
 * `tolower()` в $filter на тестовом стенде не
 * отклоняется кодом ответа: сервер отдаёт 200 и обрывает тело (см.
 * `isQueryUnsupportedError`). Раньше латч дублировался в lookup-резолвере и в
 * bpm_search_unified, а filter-compiler о нём не знал вовсе — из-за чего
 * оператор «содержит» в bpm_search_records падал сетевой ошибкой. Один общий
 * флаг закрывает все три пути сразу, в пределах текущей сессии и стенда.
 */

import { getAuthCacheScope } from '../auth/request-context.js';

const tolowerUnsupported = new Map<string, number>();
const CAPABILITY_TTL_MS = 5 * 60 * 1000;

/** Можно ли оборачивать поле в tolower() при построении $filter. */
export function isTolowerSupported(): boolean {
  const scope = getAuthCacheScope();
  const expires = tolowerUnsupported.get(scope);
  if (expires && expires > Date.now()) return false;
  tolowerUnsupported.delete(scope);
  return true;
}

/** В этой сессии инстанс отклонил tolower(); повторная проверка возможна после TTL. */
export function markTolowerUnsupported(): void {
  if (!isTolowerSupported()) return;
  const now = Date.now();
  for (const [key, expires] of tolowerUnsupported) if (expires <= now) tolowerUnsupported.delete(key);
  if (tolowerUnsupported.size >= 2000) tolowerUnsupported.delete(tolowerUnsupported.keys().next().value!);
  tolowerUnsupported.set(getAuthCacheScope(), now + CAPABILITY_TTL_MS);
  console.error('[capabilities] tolower() не поддержан инстансом, перехожу на case-sensitive поиск');
}

/** Сброс — только для тестов. */
export function resetServerCapabilities(): void {
  tolowerUnsupported.clear();
  batchSupport.clear();
  relationshipReadSupport.clear();
}

/** A result for one exact read strategy, scoped by the caller to instance, user and path. */
const RELATIONSHIP_READ_TTL_MS = 5 * 60 * 1000;
const MAX_RELATIONSHIP_READ_SCOPES = 2000;
const relationshipReadSupport = new Map<string, { supported: boolean; expires: number }>();

export function getRelationshipReadSupport(scope: string): boolean | undefined {
  const known = relationshipReadSupport.get(scope);
  if (known && known.expires > Date.now()) return known.supported;
  relationshipReadSupport.delete(scope);
  return undefined;
}

export function setRelationshipReadSupport(scope: string, supported: boolean): void {
  const now = Date.now();
  for (const [key, value] of relationshipReadSupport)
    if (value.expires <= now) relationshipReadSupport.delete(key);
  if (!relationshipReadSupport.has(scope) && relationshipReadSupport.size >= MAX_RELATIONSHIP_READ_SCOPES)
    relationshipReadSupport.delete(relationshipReadSupport.keys().next().value!);
  relationshipReadSupport.set(scope, { supported, expires: now + RELATIONSHIP_READ_TTL_MS });
}

/**
 * Поддержка $batch. undefined — ещё не проверяли или результат истёк. Проверка
 * выполняется безвредным GET внутри $batch (см. ODataClient.executeBulk); при отказе пакетные
 * инструменты шлют запросы по одному, и модель не тратит вызовы на заведомо
 * падающий путь.
 */
const BATCH_CAPABILITY_TTL_MS = 5 * 60 * 1000;
const MAX_BATCH_SCOPES = 1000;
const batchSupport = new Map<string, { supported: boolean; expires: number }>();

export function getBatchSupport(scope = ''): boolean | undefined {
  const known = batchSupport.get(scope);
  if (known && known.expires > Date.now()) return known.supported;
  batchSupport.delete(scope);
  return undefined;
}

export function setBatchSupport(supported: boolean, reason?: string, scope = ''): void {
  const now = Date.now();
  for (const [key, value] of batchSupport) if (value.expires <= now) batchSupport.delete(key);
  if (!batchSupport.has(scope) && batchSupport.size >= MAX_BATCH_SCOPES) return;
  batchSupport.set(scope, { supported, expires: now + BATCH_CAPABILITY_TTL_MS });
  if (!supported) console.error(`[capabilities] $batch не работает на инстансе (${reason}), шлю по одному`);
}
