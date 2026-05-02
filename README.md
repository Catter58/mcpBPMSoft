# MCP-сервер для BPMSoft

Подключение BPMSoft 1.8 к LLM-агенту (Claude Desktop, Cursor, любой клиент Model Context Protocol) — чтобы спросить «найди контакты из Москвы за последний месяц» или «зарегистрируй Иванова из Ромашки», а не вручную набирать OData-фильтры.

Сервер берёт на себя всё, что обычно мешает:
- авторизацию, CSRF-токены и сессии BPMSoft;
- разницу между OData v3 и v4 (форматы ID, имена полей, $batch);
- перевод «Город = Москва» в `CityId = <UUID>` через справочники;
- защиту от случайного массового удаления, переполнения контекста модели и SSRF;
- запуск бизнес-процессов через `ProcessEngineService`.

В коробке **32 инструмента, 6 prompts, 4 ресурса** — от низкоуровневого CRUD до готовых сценариев «зарегистрировать контакт + контрагента» и «найти всё про Иванова».

---

## Содержание

- [Что это решает](#что-это-решает)
- [Быстрый старт за 5 минут](#быстрый-старт-за-5-минут)
- [Подключение к Claude Desktop](#подключение-к-claude-desktop)
- [Примеры диалогов](#примеры-диалогов)
- [Все 32 инструмента — кратко](#все-32-инструмента--кратко)
- [Готовые сценарии (MCP prompts)](#готовые-сценарии-mcp-prompts)
- [Ресурсы (MCP resources)](#ресурсы-mcp-resources)
- [Конфигурация](#конфигурация)
- [Скрипты](#скрипты)
- [Отладка](#отладка)
- [Ограничения BPMSoft 1.8](#ограничения-bpmsoft-18)
- [Часто задаваемые вопросы](#часто-задаваемые-вопросы)
- [Лицензия](#лицензия)

---

## Что это решает

BPMSoft (форк Creatio) предоставляет OData-API, который мощный, но очень многословный. Запрос «контакты из Москвы, созданные на этой неделе» на чистом OData выглядит так:

```http
GET /0/odata/Contact?$filter=City/Name eq 'Москва' and CreatedOn ge 2026-04-26T00:00:00Z&$select=Id,Name,Email
Cookie: BPMSESSIONID=...; BPMCSRF=...
BPMCSRF: <csrf>
ForceUseSession: true
```

LLM-агенту, который пытается его собрать, нужно знать:
- где живёт OData (для .NET 8 — `/odata`, для .NET Framework — `/0/odata`, для v3 — отдельный путь);
- что строки в одинарных кавычках, GUID-ы у v3 в `guid'…'`, у v4 без обёртки;
- что лимит ответа 20 000 строк, $batch только в v4 и не больше 100 подзапросов;
- что lookup-поля у v4 заканчиваются на `Id`, а у v3 — нет;
- что русские названия полей доступны только через системную таблицу `SysEntitySchemaColumn`;
- и десяток других мелочей.

**Этот сервер прячет всё это за человеческим интерфейсом**:

```
Пользователь:  Найди контакты из Москвы за последние 30 дней
Агент → tool:  bpm_search_records
                 collection: "Contact"
                 criteria: [
                   { field: "Город",         op: "равно",            value: "Москва" },
                   { field: "Дата создания", op: "за последние N дней", value: 30 }
                 ]
Сервер →       Скомпилирует $filter, разрешит «Москва» в UUID города,
               применит лимит max_records (от переполнения контекста),
               вернёт сводку + первые 5 записей + cursor для следующих.
```

---

## Быстрый старт за 5 минут

**Требуется**: Node.js 18+, инстанс BPMSoft 1.8 с включённым OData (по умолчанию — да).

```bash
# 1. Склонировать репозиторий
git clone https://github.com/Catter58/mcpBPMSoft.git
cd mcpBPMSoft

# 2. Установить зависимости
npm install

# 3. Собрать
npm run build

# 4. Прописать подключение в .env (или передать переменные среды)
cp .env.example .env
# открыть .env, заполнить BPMSOFT_URL / USERNAME / PASSWORD

# 5. Запустить (с переменными среды)
npm start
```

Сервер общается через stdio — это стандартный транспорт MCP. Самостоятельный запуск нужен только для отладки; в реальной жизни сервер запускает MCP-клиент (Claude Desktop, Cursor и т.п.) — см. ниже.

### Альтернатива: интерактивная инициализация

Если не хочешь хранить пароль в `.env`, запусти сервер без переменных и попроси LLM вызвать инструмент `bpm_init`:

```
Агент: bpm_init
       url:      https://mycompany.bpmsoft.com
       username: Supervisor
       password: ***
```

Сервер сразу проверит подключение, и все остальные инструменты станут доступны.

---

## Подключение к Claude Desktop

В файле `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) или `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "bpmsoft": {
      "command": "node",
      "args": ["/абсолютный/путь/к/mcpBPMSoft/build/index.js"],
      "env": {
        "BPMSOFT_URL":      "https://mycompany.bpmsoft.com",
        "BPMSOFT_USERNAME": "Supervisor",
        "BPMSOFT_PASSWORD": "пароль",
        "BPMSOFT_ODATA_VERSION": "4",
        "BPMSOFT_PLATFORM":      "net8"
      }
    }
  }
}
```

Перезапустить Claude Desktop. В чате появится бейдж `bpmsoft`, и список из 32 инструментов будет доступен модели.

Если предпочитаешь интерактивный логин — оставь блок `env` пустым и попроси Claude вызвать `bpm_init` в начале диалога.

Полный пример — в [`examples/claude_desktop_config.json`](examples/claude_desktop_config.json).

---

## Примеры диалогов

### Пример 1 — поиск с человеческим языком

```
Пользователь: покажи активные сделки на сумму больше 500 тысяч,
              где менеджер — Иванова

Claude → bpm_search_records
  collection: "Opportunity"
  criteria: [
    { field: "Сумма",     op: "больше", value: 500000 },
    { field: "Owner",     op: "равно",  value: "Иванова" },
    { field: "Stage",     op: "не равно", value: "Закрыта (выиграна)" }
  ]
  format: "markdown"

Сервер вернёт:
  Скомпилированный $filter:
    Amount gt 500000 and OwnerId eq <UUID Ивановой>
    and StageId ne <UUID этапа закрыта>
  Получено записей: 7

  | Id  | Title              | Amount  | Stage      | Owner    |
  |-----|--------------------|---------|------------|----------|
  | ... | Поставка софта     | 1200000 | В работе   | Иванова  |
  ...
```

### Пример 2 — регистрация нового контакта

```
Пользователь: создай контакт Петров Пётр, телефон +7-999-1234567,
              работает в ООО Орбита

Claude → bpm_register_contact
  name: "Петров Пётр"
  phone: "+7-999-1234567"
  account_name: "ООО Орбита"

Сервер:
  1. Ищет Account по Name='ООО Орбита' → не нашёл → создаёт.
  2. Получает accountId.
  3. Создаёт Contact с подставленным AccountId.
  4. Возвращает оба UUID.
```

### Пример 3 — массовое обновление со страховкой

```
Пользователь: закрой все мои задачи старше года

Claude → bpm_search_records      (узнать сколько таких)
  collection: "Activity"
  criteria: [
    { field: "Owner",     op: "равно",         value: "<текущий пользователь>" },
    { field: "CreatedOn", op: "меньше",        value: "2025-05-02T00:00:00Z" },
    { field: "Status",    op: "не равно",      value: "Завершено" }
  ]

[ответ: 12 записей]

Пользователь: ага, закрывай

Claude → bpm_update_by_filter
  collection: "Activity"
  filter: "OwnerId eq <UUID> and CreatedOn lt 2025-05-02T00:00:00Z and StatusId ne <UUID Завершено>"
  data: { Status: "Завершено" }
  expected_count: 12       # страховка: если найдено иное число — операция отменится
```

### Пример 4 — запуск бизнес-процесса

```
Пользователь: запусти процесс «UsrCalculatePipeline» и покажи результат

Claude → bpm_run_process
  process_name: "UsrCalculatePipeline"
  parameters: { period_days: "30" }
  result_parameter_name: "UsrPipelineSummary"

Сервер:
  GET /ServiceModel/ProcessEngineService.svc/UsrCalculatePipeline/Execute
       ?period_days=30&ResultParameterName=UsrPipelineSummary
  Парсит XML-обёртку <string>...</string>, JSON.parse содержимого.
  Возвращает структуру в structuredContent.
```

### Пример 5 — комментарий в ленте записи

```
Пользователь: оставь в ленте этой сделки заметку «звонил, обещали вернуться в среду»

Claude → bpm_post_feed
  collection: "Opportunity"
  id: "<UUID сделки>"
  message: "звонил, обещали вернуться в среду"

Сервер:
  POST /odata/SocialMessage
  body: { Message: "...", EntitySchemaName: "Opportunity", EntityId: "..." }
```

---

## Все 32 инструмента — кратко

### Подключение

| Инструмент | Зачем |
|---|---|
| `bpm_init` | Подключиться к BPMSoft (URL, логин/пароль, OData v3/v4, платформа) |

### Чтение

| Инструмент | Зачем |
|---|---|
| `bpm_get_records` | Получить записи коллекции с фильтром/select/expand/order/top/skip; **safe-pagination** + **token-aware форматы** (compact/full/markdown); поддерживает opaque cursor |
| `bpm_get_record` | Одна запись по UUID |
| `bpm_count_records` | Количество записей по фильтру |
| `bpm_search_records` | **Поиск с критериями на русском** — массив `{field, op, value}`, операторы «равно», «содержит», «за последние N дней» и т.п.; компилирует в OData $filter |

### Запись

| Инструмент | Зачем |
|---|---|
| `bpm_create_record` | Создать запись; lookup-поля резолвятся по тексту, ключи можно на русском |
| `bpm_update_record` | Обновить по UUID |
| `bpm_delete_record` | Удалить по UUID |
| `bpm_update_by_filter` | Массовое обновление с обязательным `expected_count` (страховка) |
| `bpm_delete_by_filter` | Массовое удаление с обязательным `expected_count` |

### Схема и справочники

| Инструмент | Зачем |
|---|---|
| `bpm_get_collections` | Список доступных EntitySet |
| `bpm_get_schema` | Поля коллекции с русскими подписями, типами, lookup-связями |
| `bpm_lookup_value` | Найти UUID справочного значения; `fuzzy=true` — нечёткий поиск через `contains()` |
| `bpm_get_enum_values` | Все значения справочника, к которому привязано lookup-поле (например, все ActivityCategory) |
| `bpm_workflow_catalog` | **Карта типичных сценариев + связи между сущностями + ограничения BPMSoft 1.8.** Хорошо вызывать в начале сессии. |
| `bpm_find_field` | Найти поле по фрагменту русского/английского названия в уже загруженных схемах |
| `bpm_describe_instance` | **Сводка по инстансу** за один вызов: главные сущности, их счётчики, кастомные коллекции/поля (`Usr*`). Кеш 5 мин. |

### Пакетные операции (только OData v4)

| Инструмент | Зачем |
|---|---|
| `bpm_batch_create` | Создать N записей одним $batch |
| `bpm_batch_update` | Обновить N записей одним $batch |
| `bpm_batch_delete` | Удалить N записей одним $batch |

Все три поддерживают `continue_on_error`.

### Файлы

| Инструмент | Зачем |
|---|---|
| `bpm_upload_file` | Загрузить локальный файл в `SysImage` + опционально привязать к записи |
| `bpm_download_file` | Скачать файл из `SysImage` |
| `bpm_field_upload` | PUT бинарных данных в произвольное поле сущности (`{Coll}({id})/{Field}`) |
| `bpm_field_download` | GET бинарных данных из поля сущности |
| `bpm_field_delete` | Очистить бинарное поле |

### Готовые workflow-инструменты

| Инструмент | Зачем |
|---|---|
| `bpm_register_contact` | Создать Account (или найти) + создать Contact + привязать |
| `bpm_log_activity` | Создать Activity с резолвом типа/владельца по тексту, опц. привязка к Contact/Account/Opportunity |
| `bpm_set_status` | Сменить статус по человеческому имени; сервер сам найдёт правильное status-поле и его справочник |
| `bpm_search_unified` | Сквозной поиск по подстроке в Contact/Account/Lead/Opportunity (плоский список) |

### Бизнес-процессы и лента

| Инструмент | Зачем |
|---|---|
| `bpm_run_process` | Запустить БП через `ProcessEngineService.svc`, опц. забрать результат через `result_parameter_name` |
| `bpm_exec_process_element` | Возобновить элемент уже выполняющегося процесса по UID |
| `bpm_post_feed` | Опубликовать сообщение в ленту записи (через коллекцию `SocialMessage`) |

---

## Готовые сценарии (MCP prompts)

LLM-клиенты с поддержкой prompts (Claude Desktop, Cursor) могут вызвать готовый сценарий за одну команду — модель получит сразу шаблон с инструкциями и нужными tool-ами:

| Prompt | Аргументы | Что делает |
|---|---|---|
| `getting_started` | — | Обзор сервера, главные сущности, типичные сценарии |
| `quick_search` | `query` | Сквозной поиск + детали при необходимости |
| `create_contact_flow` | `name, account?, email?, phone?` | Регистрация контакта в один заход |
| `weekly_report` | `period_days?` | Отчёт: новые контакты, активные сделки, завершённые задачи |
| `cleanup_duplicates_check` | `collection, field?` | Поиск потенциальных дубликатов (без удаления) |
| `pipeline_analysis` | `stage_field?` | Анализ воронки Opportunity: распределение по стадиям, средняя сумма |

---

## Ресурсы (MCP resources)

Браузабельные URI, которые модель может «прочитать» вместо tool-вызова — дешевле по токенам, удобно для карточек:

```
bpmsoft://collections                    — список всех EntitySet
bpmsoft://collection/{name}              — карточка коллекции (поля + record_count)
bpmsoft://entity/{collection}/{id}       — карточка одной записи
bpmsoft://schema/{name}                  — только схема коллекции (быстрее, без count)
```

---

## Конфигурация

Все параметры — через переменные окружения. Минимально необходимы первые три, остальные имеют разумные defaults:

| Переменная | По умолчанию | Описание |
|---|---|---|
| `BPMSOFT_URL` | — *(обязательно)* | URL приложения, например `https://mycompany.bpmsoft.com` |
| `BPMSOFT_USERNAME` | — *(обязательно)* | Логин |
| `BPMSOFT_PASSWORD` | — *(обязательно)* | Пароль |
| `BPMSOFT_ODATA_VERSION` | `4` | `4` или `3` |
| `BPMSOFT_PLATFORM` | `net8` | `net8` или `netframework` |
| `BPMSOFT_PAGE_SIZE` | `5000` | Размер страницы при автопагинации |
| `BPMSOFT_MAX_BATCH_SIZE` | `100` | Лимит подзапросов в `$batch` |
| `BPMSOFT_LOOKUP_CACHE_TTL` | `300` | TTL кеша lookup в секундах |
| `BPMSOFT_REQUEST_TIMEOUT` | `30000` | Таймаут одного HTTP-запроса (мс) |
| `BPMSOFT_MAX_FILE_SIZE` | `10485760` | Лимит размера файла (10 МБ) |
| `BPMSOFT_DEBUG` | `off` | `1` — логировать `method url status duration`; `trace` — ещё и тела с маскированием паролей и токенов |

Без переменных среды сервер всё равно стартует, но любой инструмент кроме `bpm_init` ответит «сервер не инициализирован».

---

## Скрипты

```bash
npm run build         # компиляция TS -> JS в build/
npm start             # запустить собранный сервер
npm run dev           # tsc --watch на время разработки
npm test              # vitest run (95 тестов: unit + интеграция через MSW)
npm run test:watch    # тесты в watch-режиме
npm run lint          # eslint (typescript-eslint, рекомендованный preset)
npm run lint:fix      # автоисправление
npm run format        # prettier --write
npm run format:check  # prettier --check (для CI)
```

---

## Отладка

Самый быстрый способ увидеть, что именно уходит в BPMSoft — включить `BPMSOFT_DEBUG`:

```bash
BPMSOFT_DEBUG=1 npm start
# -> [HttpClient][req] GET https://.../odata/Contact?$top=10
# -> [HttpClient][res] GET .../odata/Contact -> 200 (143ms)

BPMSOFT_DEBUG=trace npm start
# -> также выводит headers и тела запросов/ответов;
#    BPMCSRF/Cookie/UserPassword автоматически маскируются.
```

Для проверки подключения без MCP-клиента можно запустить сервер напрямую — он выводит в `stderr`:

```
[Server] Configuration loaded from environment variables
  Target: https://mycompany.bpmsoft.com
  OData: v4, Platform: net8
MCP BPMSoft OData Server running on stdio
Registered 32 tools (bpm_init + 31 operational)
Registered 6 prompts, 4 resource templates
```

---

## Ограничения BPMSoft 1.8

| Ограничение | Значение |
|---|---|
| Максимум строк в OData-ответе | 20 000 |
| Максимум подзапросов в `$batch` | 100 |
| Максимальный размер файла | 10 МБ (настраивается) |
| Длина query string в OData v3 | 4 000 символов |
| `$batch` в OData v3 | **не поддерживается** (используйте v4) |
| Создание системных пользователей | не поддерживается |
| Прямой HTTP-API для EntitySchemaQuery | не предусмотрен — используйте обёртку через бизнес-процесс (см. сценарий `esq-via-process` в `bpm_workflow_catalog`) |

---

## Часто задаваемые вопросы

**LLM путается в OData-синтаксисе. Что делать?**
Используйте `bpm_search_records` с criteria-массивом. Он принимает поля по русской подписи, операторы по-русски, сам экранирует значения и ставит правильный синтаксис. Сырые `$filter` нужны только для очень специфичных случаев.

**Сервер вернул 20 000 строк в одном ответе и контекст модели «лопнул».**
По умолчанию `bpm_get_records` ограничивает выдачу `max_records=1000` и пагинация **выключена**. Если хотите всё — передайте `auto_paginate: true` и увеличьте `max_records`. Для пошагового перебора возвращается `cursor` — передайте его в следующий вызов и получите следующую страницу без перенабора параметров.

**Как назвать поле — «Город» или «City»?**
Любым. Сервер хранит двусторонний словарь caption ↔ name (по `SysSchema`/`SysEntitySchemaColumn`) и переводит сам. Если не угадал — в ошибке будут «Похоже на: …».

**Lookup-значения — UUID или текст?**
Текст. Сервер сам резолвит «Москва» → `<UUID>` через `bpm_lookup_value`. Если найдено несколько кандидатов — вернёт список и попросит уточнить.

**OData v3 на .NET Framework — будет работать?**
Да, кроме `$batch` (его в v3 BPMSoft нет). При попытке `bpm_batch_*` на v3 получите явную ошибку, а не молчаливое 404.

**Как запустить кастомный бизнес-процесс?**
`bpm_run_process` с `process_name` (имя схемы процесса) и `parameters`. Если процесс возвращает результат — добавьте `result_parameter_name`. Сервер заберёт XML-обёртку и распакует JSON-payload в `structuredContent`.

**Что если на инстансе нет коллекции `SocialMessage`?**
`bpm_post_feed` вернёт ошибку 404 с понятным сообщением «На этом инстансе нет коллекции SocialMessage; функция ленты не настроена». Лента в BPMSoft может быть выключена настройками безопасности.

---

## Архитектура (для разработчиков)

```
src/
  client/         HttpClient (binary-aware, contentKind, SSRF, 429+Retry-After)
                  ODataClient (v3/v4, $batch, nextLink, бинарные поля)
  process/        ProcessEngineClient (XML envelope parsing)
  metadata/       MetadataManager (fast-xml-parser, caption maps, suggestions)
  lookup/         LookupResolver (caption-aware, LRU, fuzzy fallback)
  utils/          errors, odata, suggest, filter-compiler, render, cursor
  prompts/        registry + register
  resources/      4 resource templates
  tools/          init, read, write, schema, describe-instance, enum,
                  workflow-catalog, batch, stream, process
  workflows/      register-contact, log-activity, set-status, search-unified

tests/            95 тестов (vitest + MSW): юнит + интеграция HTTP
```

Подробнее — в [`CLAUDE.md`](CLAUDE.md) (для разработчиков, добавляющих новые tool-ы)

---

## Лицензия

MIT — максимально свободные условия из стандартных OSS-лицензий. Использовать, изменять, распространять и встраивать в коммерческие продукты можно без ограничений; единственное требование — сохранить уведомление об авторских правах в копиях.

**Дополнительно (не юридически обязательно):** если планируете существенное переиспользование, интеграцию в коммерческий продукт или редистрибуцию под собственным брендом — автор будет признателен за короткое сообщение в GitHub: [@Catter58](https://github.com/Catter58). Это не требование лицензии, а просьба «дайте знать, чтобы я мог помочь и был в курсе».

Полный текст — в [`LICENSE`](LICENSE).
