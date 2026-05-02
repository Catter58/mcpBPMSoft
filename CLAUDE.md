# CLAUDE.md

Руководство для Claude Code (и других LLM-агентов) по работе с этим репозиторием.
Сервер реализует MCP-интеграцию с BPMSoft OData API на TypeScript (ESM, Node 18+).

## Архитектура

Слои (сверху вниз — от MCP-вызова к сети):

1. **Tools** — `src/tools/*.ts`. Каждый файл (`read-tools.ts`, `write-tools.ts`, `schema-tools.ts`,
   `batch-tools.ts`, `stream-tools.ts`, `init-tool.ts`) регистрирует MCP-инструменты через
   `server.registerTool`. Метаданные (title/description/annotations/blurb/category) живут в
   едином реестре `src/tools/registry.ts` — это единственный источник правды.
2. **Service Container** — собирается в `init-tool.ts` (`initializeServices`/`createEmptyContainer`).
   Контейнер хранит `authManager`, `odataClient`, `lookupResolver`, `metadataManager`, `httpClient`
   и `config`. Инструменты получают контейнер по ссылке и используют `notInitialized()` guard,
   если сервер ещё не сконфигурирован.
3. **ODataClient** — `src/client/odata-client.ts`. Строит URL-ы коллекций с учётом версии OData
   (v3/v4) и платформы (`net8`/`netframework`), сериализует параметры запроса (`$filter`,
   `$select`, `$expand`, `$orderby`, `$top`, `$skip`, `/$count`).
4. **HttpClient** — `src/client/http-client.ts`. Тонкая обёртка над `fetch` с управлением
   cookies, тайм-аутами, ретраями и проверкой origin. Здесь же — `buildHeaders(contentKind)`.
5. **Типы** — `src/types/index.ts` (`BpmConfig`, `ODataVersion`, `PlatformType`, и пр.).

## Поток управления

При старте `src/index.ts`:

1. `tryLoadConfigFromEnv()` пытается собрать `BpmConfig` из `BPMSOFT_URL` / `BPMSOFT_USERNAME` /
   `BPMSOFT_PASSWORD` (и опционально `BPMSOFT_ODATA_VERSION`, `BPMSOFT_PLATFORM`).
2. Если env есть — `initializeServices(config)` сразу собирает контейнер.
   Если нет — создаётся пустой контейнер; пользователь обязан вызвать `bpm_init` первым.
3. Регистрируются все группы инструментов (read/write/schema/batch/stream) и `bpm_init`.
4. На каждый MCP-вызов tool сначала проверяет `services.config` (через `notInitialized()`),
   затем вызывает `services.authManager.ensureAuthenticated()` и далее обращается к
   `odataClient` / `lookupResolver` / `metadataManager`.

## Контракт Content-Type / Accept

Все исходящие HTTP-заголовки формирует `buildHeaders(contentKind)` в `src/client/http-client.ts`.
Передавайте корректный `contentKind` — это критично для совместимости с BPMSoft:

| `contentKind` | Случаи использования                               |
|---------------|----------------------------------------------------|
| `'auth'`      | `AuthService.svc/Login` (Cookie-аутентификация)    |
| `'crud'`      | стандартные GET/POST/PATCH/DELETE по коллекциям    |
| `'batch'`     | `$batch` запросы (multipart/mixed, только v4)      |
| `'binary'`    | загрузка/скачивание файлов и бинарных полей        |
| `'metadata'`  | `$metadata` (XML), `SysSchema` lookup'ы            |
| `'count'`     | `/$count` (text/plain ответ)                       |

Не выставляйте заголовки руками в инструментах — расширяйте `buildHeaders` при необходимости.

## Защитные инварианты

- **SSRF-защита.** `HttpClient.setAllowedOrigin` фиксирует разрешённый origin при инициализации
  config-а. Любой запрос за пределы этого origin'а отклоняется до `fetch`.
- **OData-инъекции.** `isSafeIdentifier` валидирует имена коллекций/полей до подстановки в
  `$filter`/URL. Не отключайте эту проверку и не строите фильтры конкатенацией строк —
  используйте утилиты из `src/client/odata-client.ts`.
- **Лимиты контекста.** `bpm_get_records` по умолчанию НЕ автопагинирует и применяет
  `max_records` (около 1000). Для полной выгрузки клиент должен явно передать
  `auto_paginate=true` и/или больший `max_records`. Это защита от переполнения окна LLM.
- **Защита массовых операций.** `bpm_update_by_filter` и `bpm_delete_by_filter` требуют
  параметр `expected_count` — если фактическое число найденных записей не совпадает,
  операция отменяется до начала изменений.

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
   корректный MCP-ответ. Не возвращайте `isError: true` руками без необходимости.

## Тесты

- Стек: **vitest** + **MSW** (`@vitest/coverage-v8`).
- Запуск: `npm test` (один прогон), `npm run test:watch` (watch).
- Файлы тестов лежат в `tests/`. Сетевые вызовы перехватываются MSW handler-ами —
  никаких реальных HTTP-запросов в CI.

## Ограничения OData v3

- **Нет `$batch`.** Инструменты `bpm_batch_*` работают только при `odata_version=4`.
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
