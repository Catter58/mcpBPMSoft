/**
 * Возможности конкретного инстанса BPMSoft, выясняемые в бою.
 *
 * Сервер пришпилен к одному BPMSOFT_URL, поэтому «умеет / не умеет» — свойство
 * процесса, а не отдельного вызова: узнали один раз и больше не тратим на это
 * round-trip.
 *
 * Пока здесь один флаг — `tolower()` в $filter. На bpm9 такой фильтр не
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
}
