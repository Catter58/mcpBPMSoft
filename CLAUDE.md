# CLAUDE.md

Руководство для Claude Code (и других LLM-агентов) по работе с этим репозиторием.
Сервер реализует MCP-интеграцию с BPMSoft OData API на TypeScript (ESM, Node 22+), версия пакета 1.0.0, MCP SDK 1.29.

## Архитектура

Слои (сверху вниз — от MCP-вызова к сети):

1. **Tools** — `src/tools/*.ts`. Каждый файл (`read-tools.ts`, `write-tools.ts`, `schema-tools.ts`,
   `batch-tools.ts`, `stream-tools.ts`, `init-tool.ts`) регистрирует MCP-инструменты через
   `server.registerTool`. Метаданные (title/description/annotations/blurb/category) живут в
   едином реестре `src/tools/registry.ts` — это единственный источник правды.
2. **Service Container** — собирается в `init-tool.ts` (`initializeServices`/`createEmptyContainer`).
   Контейнер хранит `authManager`, `odataClient`, `lookupResolver`, `metadataManager`, `httpClient`
   `currentUser`, `processEngine` и `config`. Инструменты получают контейнер по ссылке и используют `notInitialized()` guard,
   если сервер ещё не сконфигурирован.
3. **ODataClient** — `src/client/odata-client.ts`. Строит URL-ы коллекций с учётом версии OData
   (v3/v4) и платформы (`net8`/`netframework`), сериализует параметры запроса (`$filter`,
   `$select`, `$expand`, `$orderby`, `$top`, `$skip`, `/$count`).
4. **HttpClient** — `src/client/http-client.ts`. Тонкая обёртка над `fetch` с управлением
   cookies, тайм-аутами, ретраями и проверкой origin. Здесь же — `buildHeaders(contentKind)`.
5. **Типы** — `src/types/index.ts` (`BpmConfig`, `ODataVersion`, `PlatformType`, и пр.).

HTTP-маршрут выбирает контейнер только через `src/server/tenant-registry.ts` — operator allowlist,
никаких URL из аргументов tool. `src/server/tool-server.ts` переиспользует определения и скомпилированные
схемы внутри контейнера одного стенда, но каждый HTTP-запрос получает отдельные SDK protocol/transport.
`request-runtime.ts` владеет допуском HTTP, общим бюджетом read-only tool и отменой upstream;
`operation-journal.ts` сохраняет намерения и исходы изменений, `operation-tool.ts` читает только свои записи.

## Модель авторизации и транспорт

**Транспорт по умолчанию — Streamable HTTP** (порт `MCP_HTTP_PORT`, default 8007).
Для локальной отладки: `MCP_TRANSPORT=stdio`.

**Авторизация по умолчанию — per-request.**
Вызовы BPMSoft передают заголовок `BPMCSRF` и cookie сессии `.ASPXAUTH` или
`BPMSESSIONID`; `CsrfToken`, когда он передан, также пробрасывается.
Сервер извлекает авторизацию через AsyncLocalStorage и передаёт
в OData-запросы к BPMSoft. Per-request cookies не становятся общей конфигурацией или журналом
авторизации; кэши разделены по полному auth+tenant контексту. Журнал изменений хранит бизнес-намерения
и receipts с удалением известных секретных полей и бинарных payload. Запрос без авторизации →
`AuthRequiredError`. Эта модель аналогична mcp-proxy-server.

**По умолчанию `BPMSOFT_URL` обязателен.** Сохраняются один стенд, `/mcp` и `/`;
`BPMSOFT_TENANTS_FILE` без явного `BPMSOFT_MULTITENANT=true` игнорируется.

**Несколько стендов — отдельный явный HTTP-режим.** Нужны `BPMSOFT_MULTITENANT=true` и
`BPMSOFT_TENANTS_FILE` со списком `{id,url,odata_version?,platform?}`. Маршрут
`/tenants/<id>/mcp` выбирает только ID allowlist; неизвестный ID → 404. `BPMSOFT_URL`
не выбирает стенд в этом режиме. Общие env-креды и stdio запрещены. Файл читается при старте.

**Env-creds — скрытый opt-in** (`BPMSOFT_ALLOW_ENV_CREDS=true`). При включении:

- добавляется путь логина через `BPMSOFT_USERNAME` / `BPMSOFT_PASSWORD`;
- регистрируется инструмент `bpm_init`.
  По умолчанию `bpm_init` **не регистрируется**. В документации и подсказках по умолчанию
  env-creds путь не упоминается — показывать только если opt-in явно включён.

## Поток управления

При старте `src/index.ts`:

1. `loadTenantRegistry()` выбирает режим по явному флагу. Без него требуется `BPMSOFT_URL`;
   в multi-режиме проверяется операторский JSON и создаются отдельные контейнеры стендов.
2. `buildConfig()` проверяет URL, OData, платформу и числовые ограничения. Целевой origin
   и base path разрешаются только из конфигурации стенда.
3. Если `BPMSOFT_ALLOW_ENV_CREDS=true` — дополнительно подтягиваются
   `BPMSOFT_USERNAME` / `BPMSOFT_PASSWORD`; регистрируется `bpm_init`.
4. Сервис-контейнер собирается сразу; авторизационный контекст каждого запроса
   хранится в AsyncLocalStorage и живёт ровно время одного MCP-вызова.
5. HTTP допускает запрос в пределах общей очереди и лимита auth+tenant scope до чтения тела;
   после этого отдельный SDK server/transport получает переиспользуемые определения инструментов.
6. На каждый MCP-вызов tool использует ALS, read-only бюджет или журнал изменений,
   затем обращается к сервисам выбранного стенда. `bpm_get_operation` регистрируется только
   при journal_root; в single-mode это opt-in, в multi-mode по умолчанию `./state/operations`.

## Контракт Content-Type / Accept

Все исходящие HTTP-заголовки формирует `buildHeaders(contentKind)` в `src/client/http-client.ts`.
Передавайте корректный `contentKind` — это критично для совместимости с BPMSoft:

| `contentKind` | Случаи использования                            |
| ------------- | ----------------------------------------------- |
| `'auth'`      | `AuthService.svc/Login` (Cookie-аутентификация) |
| `'crud'`      | стандартные GET/POST/PATCH/DELETE по коллекциям |
| `'batch'`     | нативные JSON `$batch` запросы (только v4)      |
| `'binary'`    | загрузка/скачивание файлов и бинарных полей     |
| `'metadata'`  | `$metadata` (XML), `SysSchema` lookup'ы         |
| `'count'`     | `/$count` (text/plain ответ)                    |

Не выставляйте заголовки руками в инструментах — расширяйте `buildHeaders` при необходимости.

## Защитные инварианты

- **SSRF-защита.** `HttpClient` фиксирует разрешённый origin из конфигурации подключения.
  В мультитенантном режиме также проверяется base path приложения. Запросы и перенаправления
  за соответствующие границы отклоняются.
- **OData-инъекции.** `isSafeIdentifier` валидирует имена коллекций/полей до подстановки в
  `$filter`/URL. Не отключайте эту проверку и не строите фильтры конкатенацией строк —
  используйте утилиты из `src/client/odata-client.ts`.
- **Лимиты ответа.** `bpm_get_records` по умолчанию НЕ автопагинирует: страница — 20 записей,
  `top` и `max_records` не превышают 1000. При `auto_paginate=true` количество определяется
  `max_records`, а не `top`. Общая обёртка отвергает полный JSON-результат инструмента с
  `readOnlyHint=true` сверх 64 КиБ UTF-8, включая `structuredContent`, до и после текстового
  сокращения. Возвращается `isError=true`, `code=response_too_large`, без данных и cursor.
  Обработчики записей сохраняют подтверждения исхода; их результаты, файлы с `readOnlyHint=false`
  и отдельно зарегистрированные ресурсы в этот предел не входят. Это ограничение одного ответа,
  а не всей истории модели. Существующие лимиты текста и исходной выборки также сохраняются.
- **Бюджет чтения.** Один `readOnlyHint=true` tool по умолчанию ограничен 120 секундами,
  100 фактическими upstream попытками и 64 МиБ декодированных байт. Retries, redirects и
  параллельные вызовы используют один бюджет. Exhaustion прекращает чтение с `budget_exceeded`;
  обработчик не должен скрывать этот исход как полный успешный результат. Ресурсы и инструменты
  с `readOnlyHint=false` не получают этот бюджет. Disconnect отменяет upstream ожидание, не откатывает запись.
- **HTTP-допуск.** По умолчанию 500 активных, 500 ожидающих и 50 активных на полный auth+tenant
  scope. Overload → HTTP 429 с Retry-After, до выполнения MCP-запроса. Не подменяйте scope
  непроверенным пользовательским ID. `healthz` — только liveness без обращения к BPMSoft.
- **Личные HTTP-файлы.** `src/utils/file-access.ts` — единственная политика допуска путей:
  tenant hash включает настроенный ID и URL, user hash — UUID из BPMSoft current-user macro.
  Cookies/header userId не определяют namespace. Каталоги 0700, файлы 0600, без symlinks/перезаписи;
  общий корень не читается HTTP-клиентами. stdio сохраняет доверенные пути. CurrentUser cache
  ограничен 2000 записями, TTL/LRU/singleflight; новый cookie подтверждается заново, но тот же UUID сохраняет файлы.
- **Долговечные исходы.** При journal_root намерение/checkpoint сохраняются до upstream изменения,
  receipts — после него. Недоступное сохранение до dispatch прекращает следующий этап. Запись с
  `outcome_unknown` требует сверки состояния. `bpm_get_operation` читает только свой tenant/user
  namespace, поддерживает own list и pages этапов. Журнал не replay/exactly-once/rollback;
  подтверждения, проверка ETag и идемпотентность сохраняют собственные контракты.
- **Защита массовых операций.** `bpm_update_by_filter` и `bpm_delete_by_filter` ничего не меняют
  без `expected_count`: такой вызов возвращает превью (число найденных и их Id). Если фактическое
  число не совпадает с `expected_count`, операция отменяется до начала изменений. Выполнение
  требует одноразовый `confirmation_token` из предварительного просмотра; токен связан
  с пользователем, параметрами, UUID и снимками записей. Одного `confirm=true` недостаточно.
- **Lookup-фильтры через навигацию (v4).** `filter-compiler` берёт navigation/key из метаданных,
  сравнивает uuid как `Nav/Key eq`, `ne` — как `not (Nav/Key eq)`, пустоту — `Nav eq null` /
  `Nav/Key ne null`. Не угадывайте имя навигации или ключа по суффиксу поля.
- **Обязательные поля и типы.** Обязательность и значения по умолчанию получаются из
  EntitySchemaDesigner; `nullable=false` не заменяет эту информацию. Неизвестная обязательность
  явно отмечается. Перед записью используйте общую проверку полей и lookup; Decimal/Int64
  нельзя преобразовывать в Number. В нативном batch точные числовые токены допустимы только
  для полей, тип которых известен из метаданных.
- **Неопределённый исход.** Запись после сетевой ошибки или таймаута автоматически не повторяется.
  Неизвестный результат останавливает последующие изменения и зависимые пересчёты.
- **Контракт ошибок.** Единственный машиночитаемый признак неуспеха — `CallToolResult.isError: true`;
  текст в `content` сигналом НЕ является (клиент-адаптер MCP читает только `isError`). Любой реальный
  сбой → `isError: true`: провалился хотя бы один элемент `bpm_batch_*`/`*_by_filter`/`bpm_merge_duplicates`
  (не только когда упали все), не удалось записать файл (`bpm_download_file`), не загрузилась обязательная
  секция/коллекция (`bpm_record_card`, `bpm_search_unified`, `bpm_my_agenda`). Не-ошибки — пустой результат
  («не найдено»), неоднозначность lookup, запрос подтверждения (`confirm`), «уже существует», усечение
  («итоги неполные») — остаются без `isError`/`false`, иначе агент примет их за сбой.

## Как добавить новый MCP-tool

1. **Зарегистрировать метаданные.** Добавьте запись в `TOOLS` в `src/tools/registry.ts`:
   `name`, `title`, `description` (на русском, развёрнуто — это читает LLM-агент),
   `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`),
   `blurb` для приветственного листинга и `category` (`'read' | 'write' | 'schema'
| 'batch' | 'stream'`).
2. **Реализовать tool.** В соответствующем `src/tools/*-tools.ts` вызовите `server.registerTool`.
   Подтяните метаданные через `getTool('bpm_xxx')` — не дублируйте title/description.
3. **Guard на инициализацию.** В начале handler-а вызовите `notInitialized(services)` —
   если контейнер пуст, верните пользователю подсказку запустить `bpm_init`.
4. **Вызовы.** `await services.authManager.ensureAuthenticated()` перед обращением к API.
   Для CRUD используйте `services.odataClient`, для lookup'ов —
   `services.lookupResolver`, для схемы — `services.metadataManager`.
5. **`structuredContent`.** Заполняйте, когда это даёт LLM полезную машиночитаемую структуру
   (списки записей, count, схемы). Для текстовых результатов используйте только `content`.
6. **Ошибки.** Бросайте `Error` с понятным русским сообщением — runtime обернёт его в
   MCP-ответ с `isError: true`. Если handler сам собирает результат с ошибками по элементам
   (например `bpm_batch_*`), ставьте `isError: true`, как только есть хотя бы один сбой.
   Не-ошибки (пусто, неоднозначность, подтверждение, усечение) — без `isError`.

## Тесты

- Стек: **vitest** + **MSW** (`@vitest/coverage-v8`).
- Запуск: `npm test` (один прогон), `npm run test:watch` (watch).
- Файлы тестов лежат в `tests/`. BPMSoft моделируется через MSW или подменённый fetch;
  HTTP-транспорт проверяется настоящими запросами к loopback, без внешнего стенда.
- Проверки изоляции и восстановления используют полную производственную фабрику и MCP SDK
  с моделируемым upstream. Нагрузочный тест 500 — проверка overlap/context isolation, не доказательство
  вместимости реального стенда.

## Ограничения OData v3

- **Нет нативного `$batch`.** Инструменты `bpm_batch_*` используют последовательный режим
  при v3 или подтверждённой недоступности нативного batch и возвращают выбранный режим.
- **Формат ID.** В URL-ах ключ — `(guid'00000000-0000-0000-0000-000000000000')`,
  а не `(00000000-...)` как в v4.
- **Суффикс `Collection`.** Имена EntitySet в v3 имеют суффикс `Collection`
  (например, `ContactCollection`); в v4 — без суффикса (`Contact`). Учитывайте
  это при ручной работе со схемой.
- **Платформа.** v3 поддерживается только на `netframework`. Комбинация
  `odata_version=3 + platform=net8` запрещена и валидируется в `buildConfig`.

## Style guide

- **Кавычки и точки с запятой.** Single quotes, всегда `;` в конце statement'а.
- **Отступы.** 2 пробела (никаких табов).
- **`printWidth`** ≈ 110 (см. `.prettierrc.json`).
- **Импорты.** Только named exports; именованные импорты через `.js`-суффикс
  (требование Node16 ESM resolution для TypeScript).
- **Async/await.** Никаких голых `.then().catch()` — оборачивайте в `try/catch`.
- **Эмодзи.** В коде НЕ используются. Единственное исключение — пользовательские
  сообщения внутри `init-tool.ts` (приветственный текст после успешного `bpm_init`).
- **Логирование.** Только `console.error` (stdout зарезервирован для MCP stdio-транспорта).

## Полезные команды

```bash
npm run build        # tsc -> build/
npm run dev          # tsc --watch
npm test             # vitest run
npm run lint         # eslint src/ tests/
npm run lint:fix     # eslint --fix
npm run format       # prettier --write
npm run format:check # prettier --check
```
