/**
 * Возможности конкретного инстанса BPMSoft, выясняемые в бою.
 *
 * Проверенные возможности повторно используются, чтобы не тратить запросы
 * на заведомо неподдерживаемые конструкции. Поддержка batch ограничена сроком
 * жизни и контекстом подключения, пользователя и коллекции.
 *
 * Пока здесь один флаг — `tolower()` в $filter. На тестовом стенде такой фильтр не
 * отклоняется кодом ответа: сервер отдаёт 200 и обрывает тело (см.
 * `isQueryUnsupportedError`). Раньше латч дублировался в lookup-резолвере и в
 * bpm_search_unified, а filter-compiler о нём не знал вовсе — из-за чего
 * оператор «содержит» в bpm_search_records падал сетевой ошибкой. Один общий
 * флаг закрывает все три пути сразу.
 */

let tolowerUnsupported = false;

/** Можно ли оборачивать поле в tolower() при построении $filter. */
export function isTolowerSupported(): boolean {
  return !tolowerUnsupported;
}

/** Инстанс не переварил tolower() — до конца жизни процесса работаем case-sensitive. */
export function markTolowerUnsupported(): void {
  if (tolowerUnsupported) return;
  tolowerUnsupported = true;
  console.error('[capabilities] tolower() не поддержан инстансом, перехожу на case-sensitive поиск');
}

/** Сброс — только для тестов. */
export function resetServerCapabilities(): void {
  tolowerUnsupported = false;
  batchSupport.clear();
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
