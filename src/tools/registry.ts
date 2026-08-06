/**
 * Single source of truth for MCP tool metadata.
 *
 * Each tool registered via server.registerTool consults this list for its
 * title/description/annotations. The `bpm_init` welcome message and the
 * startup log read from the same list — no more drift between counts.
 *
 * Описания следуют конвенциям mcp-builder: что делает, пример вызова,
 * когда (не) применим, ссылки на смежные инструменты. Стиль — дескриптивный.
 */

export interface ToolDescriptor {
  name: string;
  /** Short title shown in MCP clients */
  title: string;
  /** Long description used by LLM agents to decide when to call this tool */
  description: string;
  /** MCP annotations: hints to clients about side effects */
  annotations: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  /** Short blurb for bpm_init success listing */
  blurb: string;
  /** Logical category for grouping in docs/help */
  category: 'init' | 'read' | 'write' | 'schema' | 'batch' | 'stream' | 'workflow' | 'process';
}

export const TOOLS: ToolDescriptor[] = [
  {
    name: 'bpm_init',
    title: 'Подключиться к BPMSoft',
    description:
      'Устанавливает подключение к BPMSoft по логину/паролю и проверяет учётные данные. ' +
      'Пример: {"url": "https://my.bpmsoft.ru", "username": "Supervisor", "password": "***"}. ' +
      'Нужен только в режиме env-creds без сохранённого подключения; при per-request авторизации ' +
      '(заголовок BPMCSRF + cookies) не требуется. После успеха доступны все остальные инструменты.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'инициализация подключения (URL, логин/пароль, OData v3/4, платформа)',
    category: 'init',
  },

  // ---- READ ----
  {
    name: 'bpm_get_records',
    title: 'Список записей коллекции',
    description:
      'Возвращает записи OData-коллекции с $filter/$select/$orderby/$expand/$top/$skip. ' +
      'Пример: {"collection": "Contact", "filter": "Name eq \'Иванов\'", "select": "Id,Name", "top": 10}. ' +
      'Подходит, когда $filter уже известен; для человекочитаемых критериев, русских названий полей ' +
      'и нечёткого поиска лучше bpm_search_records (сам скомпилирует $filter). ' +
      'По умолчанию автопагинация выключена и действует лимит max_records≈1000 (защита контекста LLM); ' +
      'продолжение — по cursor из ответа. Ответ: records + count/total_count/has_more/cursor.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'получить записи коллекции (фильтр/select/expand/order/top/skip, безопасный лимит)',
    category: 'read',
  },
  {
    name: 'bpm_get_record',
    title: 'Запись по ID',
    description:
      'Возвращает одну запись коллекции по UUID с опциональными $select и $expand. ' +
      'Пример: {"collection": "Account", "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6", "expand": "PrimaryContact"}. ' +
      'Когда UUID неизвестен, сначала bpm_lookup_value (имя → UUID) или bpm_search_unified.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'получить запись по UUID',
    category: 'read',
  },
  {
    name: 'bpm_count_records',
    title: 'Количество записей',
    description:
      'Возвращает число записей коллекции через /$count, опционально с $filter. ' +
      'Пример: {"collection": "Lead", "filter": "CreatedOn ge 2026-01-01T00:00:00Z"}. ' +
      'Дешевле выборки записей; полезен перед bpm_update_by_filter/bpm_delete_by_filter ' +
      'для определения expected_count.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'подсчёт записей с опциональным фильтром',
    category: 'read',
  },
  {
    name: 'bpm_search_records',
    title: 'Поиск с критериями (рус.)',
    description:
      'Поиск по массиву criteria [{field, op, value}] без ручного OData-синтаксиса: field принимает ' +
      'русские подписи («Город») и навигационные пути (Account.City), op — русские и OData-операторы. ' +
      'Пример: {"collection": "Contact", "criteria": [{"field": "Город", "op": "равно", "value": "Москва"}, ' +
      '{"field": "Name", "op": "похоже на", "value": "АО «ЛАНИТ»"}]}. ' +
      '«содержит» регистронезависим; «похоже на»/similar_to дополнительно игнорирует кавычки и ' +
      'орг-формы (АО/ООО/...). Сервер компилирует корректный $filter сам — предпочтительнее ' +
      'bpm_get_records с ручным filter. Ответ: compiled_filter, records, count/total_count/has_more/cursor.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'поиск по criteria-DSL (RU/EN, авто-резолвинг полей, similar_to)',
    category: 'read',
  },

  // ---- WRITE ----
  {
    name: 'bpm_create_record',
    title: 'Создать запись',
    description:
      'Создаёт запись в коллекции (POST). Lookup-поля принимают текст вместо UUID — сервер разрешает ' +
      'их каскадно (точное совпадение → нечёткое: кавычки/орг-формы/регистр игнорируются). ' +
      'Пример: {"collection": "Contact", "data": {"Name": "Иванов Иван", "Город": "Москва", "AccountId": "Ланит"}}. ' +
      'Неточно разрешённые поля перечислены в resolved_lookups; при нескольких кандидатах — ошибка ' +
      'lookup_ambiguous со списком (тогда нужен точный текст или UUID). Возвращает созданную запись.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    blurb: 'создать запись (с авторезолвингом lookup-полей)',
    category: 'write',
  },
  {
    name: 'bpm_update_record',
    title: 'Обновить запись',
    description:
      'Обновляет поля записи по UUID (PATCH). Lookup-поля с текстом разрешаются каскадно, как в ' +
      'bpm_create_record; неточные резолвы видны в resolved_lookups. ' +
      'Пример: {"collection": "Contact", "id": "<uuid>", "data": {"Должность": "Директор"}}. ' +
      'Для смены статуса по имени удобнее bpm_set_status; для массового обновления — bpm_update_by_filter. ' +
      'Идемпотентно при одинаковых данных.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    blurb: 'обновить запись по UUID',
    category: 'write',
  },
  {
    name: 'bpm_delete_record',
    title: 'Удалить запись',
    description:
      'Удаляет запись по UUID (DELETE). Действие необратимо, протокол двухшаговый: вызов без ' +
      'confirm=true возвращает превью удаляемой записи, ничего не удаляя; повторный вызов с ' +
      'confirm=true после явного согласия пользователя выполняет удаление. ' +
      'Пример: {"collection": "Contact", "id": "<uuid>", "confirm": true}. ' +
      'Для удаления по условию — bpm_delete_by_filter, набора UUID — bpm_batch_delete.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    blurb: 'удалить запись по UUID (требует confirm=true)',
    category: 'write',
  },
  {
    name: 'bpm_update_by_filter',
    title: 'Обновить по фильтру',
    description:
      'Находит записи по $filter и обновляет каждую (PATCH). Защита: обязательный expected_count — ' +
      'при несовпадении с фактическим числом найденных операция отменяется (код expected_count_mismatch). ' +
      'Пример: {"collection": "Case", "filter": "StatusId eq <uuid>", "data": {"OwnerId": "Петров"}, "expected_count": 12}. ' +
      'Число для expected_count даёт предварительный bpm_count_records/bpm_search_records с тем же условием.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    blurb: 'массовое обновление по фильтру (с защитным expected_count)',
    category: 'write',
  },
  {
    name: 'bpm_delete_by_filter',
    title: 'Удалить по фильтру',
    description:
      'Находит записи по $filter и удаляет каждую. Необратимо; двойная защита: (1) обязательный ' +
      'expected_count — отмена при несовпадении; (2) без confirm=true возвращается только список ID ' +
      'на удаление, само удаление — повторным вызовом с confirm=true после согласия пользователя. ' +
      'Пример: {"collection": "Activity", "filter": "CreatedOn lt 2020-01-01T00:00:00Z", "expected_count": 5, "confirm": true}. ' +
      'Число заранее даёт bpm_count_records с тем же фильтром.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    blurb: 'массовое удаление по фильтру (expected_count + confirm=true)',
    category: 'write',
  },

  // ---- SCHEMA / LOOKUP ----
  {
    name: 'bpm_get_collections',
    title: 'Список коллекций',
    description:
      'Возвращает доступные EntitySet (коллекции) BPMSoft из $metadata, опционально с фильтром-подстрокой. ' +
      'Пример: {"pattern": "Contact"}. Первый шаг при ошибке not_found по имени коллекции; ' +
      'обзор инстанса целиком — bpm_describe_instance.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'список доступных коллекций',
    category: 'schema',
  },
  {
    name: 'bpm_get_schema',
    title: 'Схема коллекции',
    description:
      'Возвращает схему коллекции: поля, типы, обязательность, lookup-связи и русские подписи ' +
      '(из SysSchema/SysEntitySchemaColumn, когда доступны). Пример: {"collection": "Contact"}. ' +
      'Нужна перед созданием записей с strict_required и при ошибках validation о неизвестных полях; ' +
      'поиск поля по подписи без загрузки всей схемы — bpm_find_field.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'схема коллекции (поля, типы, lookup, рус. подписи)',
    category: 'schema',
  },
  {
    name: 'bpm_lookup_value',
    title: 'Найти UUID по значению',
    description:
      'Резолвит UUID записи справочника по текстовому значению. По умолчанию работает каскад: точное ' +
      'совпадение → contains без учёта регистра → поиск по «ядру» имени (кавычки и орг-формы АО/ООО/ПАО ' +
      'игнорируются) с ранжированием кандидатов — «Ланит» найдёт «АО «ЛАНИТ»». ' +
      'Пример: {"collection": "Account", "value": "Ланит"}. Уверенный лидер возвращается сразу ' +
      '(fuzzy=true + matched_value); несколько сопоставимых — ранжированный список кандидатов. ' +
      'Просмотр всех значений справочника поля — bpm_get_enum_values.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'найти UUID по тексту (нечёткий каскад: кавычки/орг-формы/регистр)',
    category: 'schema',
  },
  {
    name: 'bpm_get_enum_values',
    title: 'Значения справочника поля',
    description:
      'Возвращает значения справочника, к которому привязано lookup-поле коллекции (Id + название). ' +
      'Пример: {"collection": "Activity", "field": "ActivityCategory"} → все категории активностей; ' +
      'field принимает и русскую подпись («Тип активности»). Полезен перед bpm_create_record/' +
      'bpm_update_record для выбора допустимого значения; точечный резолв одного значения — bpm_lookup_value.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'значения справочника для lookup-поля',
    category: 'schema',
  },
  {
    name: 'bpm_workflow_catalog',
    title: 'Каталог типичных сценариев',
    description:
      'Возвращает карту типичных пользовательских сценариев BPMSoft (какие инструменты для какой задачи), ' +
      'граф основных сущностей со связями и ограничения платформы 1.8. ' +
      'Пример: {} — весь каталог, {"scenario_id": "mass-delete"} — один сценарий. ' +
      'Полезен в начале сессии для ориентации; обзор конкретного инстанса — bpm_describe_instance.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    blurb: 'каталог сценариев и карта сущностей',
    category: 'schema',
  },
  {
    name: 'bpm_find_field',
    title: 'Поиск поля по подписи',
    description:
      'Находит поля по фрагменту русского/английского названия среди уже загруженных схем. ' +
      'Пример: {"search": "ИНН", "collection": "Account"} → Account.UsrINN. ' +
      'Работает по кешу схем: если коллекция ещё не загружалась, её стоит указать параметром collection ' +
      '(схема подтянется автоматически). Полный список полей коллекции — bpm_get_schema.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'поиск поля по подписи (RU/EN)',
    category: 'schema',
  },
  {
    name: 'bpm_describe_instance',
    title: 'Краткая сводка по инстансу BPMSoft',
    description:
      'Возвращает обзор инстанса за один вызов: число коллекций, присутствующие основные сущности ' +
      '(Contact, Account, Activity, Lead, Opportunity, Order, Case) со счётчиками записей и кастомных ' +
      'Usr*-полей, список кастомных коллекций. Пример: {}. Результат кешируется на 5 минут. ' +
      'Хорош как первый вызов в диалоге с новым инстансом; сценарная карта — bpm_workflow_catalog.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'обзор инстанса (главные сущности, кастомные коллекции/поля)',
    category: 'schema',
  },

  // ---- BATCH (v4 only) ----
  {
    name: 'bpm_batch_create',
    title: 'Пакетное создание',
    description:
      'Создаёт несколько записей одним $batch-запросом (только OData v4; на v3 — ошибка batch_unsupported). ' +
      'Lookup-поля резолвятся как в bpm_create_record (неточные — в resolved_lookups). ' +
      'Пример: {"collection": "Contact", "records": [{"Name": "А"}, {"Name": "Б"}], "continue_on_error": true}. ' +
      'continue_on_error=true пропускает ошибочные записи вместо остановки. До ~100 записей за вызов.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    blurb: 'пакетное создание (OData v4)',
    category: 'batch',
  },
  {
    name: 'bpm_batch_update',
    title: 'Пакетное обновление',
    description:
      'Обновляет несколько записей одним $batch-запросом (только OData v4). ' +
      'Пример: {"collection": "Contact", "updates": [{"id": "<uuid1>", "data": {"Job": "Директор"}}]}. ' +
      'Lookup-поля резолвятся автоматически; continue_on_error пропускает ошибочные элементы. ' +
      'Когда записи отбираются условием, а не списком UUID — bpm_update_by_filter.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    blurb: 'пакетное обновление (OData v4)',
    category: 'batch',
  },
  {
    name: 'bpm_batch_delete',
    title: 'Пакетное удаление',
    description:
      'Удаляет набор записей по UUID одним $batch-запросом (только OData v4). Необратимо; без ' +
      'confirm=true возвращает превью списка ID, удаление — повторным вызовом с confirm=true после ' +
      'согласия пользователя. Пример: {"collection": "Contact", "ids": ["<uuid1>", "<uuid2>"], "confirm": true}. ' +
      'Удаление по условию — bpm_delete_by_filter.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    blurb: 'пакетное удаление (OData v4, требует confirm=true)',
    category: 'batch',
  },

  // ---- STREAM ----
  {
    name: 'bpm_upload_file',
    title: 'Загрузить файл в SysImage',
    description:
      'Загружает локальный файл в хранилище SysImage (метаданные + бинарные данные) и опционально ' +
      'привязывает его к записи. Пример: {"file_path": "/tmp/scan.pdf", "target_collection": "Account", ' +
      '"target_id": "<uuid>", "target_field": "UsrContractScanId"} — все три target-параметра вместе. ' +
      'Прямая запись в произвольное бинарное поле сущности — bpm_field_upload.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    blurb: 'загрузить файл (через SysImage)',
    category: 'stream',
  },
  {
    name: 'bpm_download_file',
    title: 'Скачать файл из SysImage',
    description:
      'Скачивает бинарные данные из SysImage по UUID; с save_path сохраняет на диск, без — возвращает ' +
      'метаданные и размер. Пример: {"image_id": "<uuid>", "save_path": "/tmp/file.pdf"}. ' +
      'Чтение произвольного бинарного поля сущности — bpm_field_download.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'скачать файл из SysImage',
    category: 'stream',
  },
  {
    name: 'bpm_field_upload',
    title: 'Загрузить бинарь в поле',
    description:
      'PUT бинарных данных напрямую в поле сущности ({Collection}({id})/{Field}) — для произвольных ' +
      'бинарных полей, не только SysImage. ' +
      'Пример: {"collection": "Contact", "id": "<uuid>", "field": "Photo", "file_path": "/tmp/photo.jpg"}. ' +
      'Файл с привязкой через общее хранилище — bpm_upload_file.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'PUT бинарь в поле сущности',
    category: 'stream',
  },
  {
    name: 'bpm_field_download',
    title: 'Скачать бинарь из поля',
    description:
      'GET бинарных данных из поля сущности ({Collection}({id})/{Field}); с save_path сохраняет файл, ' +
      'без — возвращает размер. Пример: {"collection": "Contact", "id": "<uuid>", "field": "Photo", ' +
      '"save_path": "/tmp/photo.jpg"}.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'GET бинарь из поля сущности',
    category: 'stream',
  },
  {
    name: 'bpm_field_delete',
    title: 'Очистить бинарное поле',
    description:
      'DELETE бинарных данных в поле сущности. Без confirm=true возвращает превью того, что будет ' +
      'очищено; очистка — повторным вызовом с confirm=true после согласия пользователя. ' +
      'Пример: {"collection": "Contact", "id": "<uuid>", "field": "Photo", "confirm": true}.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    blurb: 'DELETE бинарь в поле сущности (требует confirm=true)',
    category: 'stream',
  },

  // ---- WORKFLOW (composite scenarios on top of CRUD) ----
  {
    name: 'bpm_register_contact',
    title: 'Зарегистрировать контакт',
    description:
      'Регистрирует контакт одним вызовом: опционально находит или создаёт контрагента (Account) по ' +
      'имени и привязывает контакт к нему — вместо цепочки create/update. ' +
      'Пример: {"name": "Иванов Иван", "email": "i@example.ru", "account_name": "Ланит", ' +
      '"extra": {"Город": "Москва"}}. Имена полей в extra — на русском или латинице. ' +
      'Точечный контроль над полями — обычный bpm_create_record.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    blurb: 'регистрация контакта (+ привязка к контрагенту по имени)',
    category: 'workflow',
  },
  {
    name: 'bpm_log_activity',
    title: 'Зафиксировать активность',
    description:
      'Создаёт активность (задача, звонок, встреча) с привязкой к записи; тип и владелец резолвятся по ' +
      'тексту через справочники, имена полей автоопределяются по метаданным инстанса. ' +
      'Пример: {"title": "Позвонить клиенту", "type": "Звонок", "owner_name": "Петров", ' +
      '"related_collection": "Account", "related_id": "<uuid>", "due_date": "2026-08-10T12:00:00Z"}. ' +
      'Комментарий в ленту записи (без задачи) — bpm_post_feed.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    blurb: 'создать активность (тип/владелец/связь резолвятся по тексту)',
    category: 'workflow',
  },
  {
    name: 'bpm_set_status',
    title: 'Установить статус записи',
    description:
      'Ставит статус записи по человекочитаемому имени: поле-статус (StatusId/StageId/...) находится в ' +
      'метаданных автоматически, UUID значения резолвится в его справочнике. ' +
      'Пример: {"collection": "Opportunity", "id": "<uuid>", "status": "Завершена успешно"}. ' +
      'При нескольких статусных полях нужен явный status_field. Прочие поля — bpm_update_record.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'установить статус по имени (Status/Stage авто-детект)',
    category: 'workflow',
  },
  {
    name: 'bpm_search_unified',
    title: 'Сквозной поиск',
    description:
      'Сквозной поиск по Name в основных коллекциях (Contact, Account, Lead, Opportunity) — первый шаг ' +
      'для запросов вида «найди всё про Иванова». Поиск регистронезависимый; при пустом результате ' +
      'повторяется по «ядру» имени (кавычки/орг-формы игнорируются): «АО ЛАНИТ» найдёт «АО «ЛАНИТ»». ' +
      'Пример: {"query": "Ланит"} или {"query": "Иванов", "collections": ["Contact"]}. ' +
      'Возвращает плоский список {collection, id, name, match_type}; уточнение по полям — bpm_search_records.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'сквозной поиск по Name (нечёткий фолбэк по ядру имени)',
    category: 'workflow',
  },

  // ---- PROCESS / FEED (BPMSoft outside OData) ----
  {
    name: 'bpm_run_process',
    title: 'Запустить бизнес-процесс',
    description:
      'Вызывает ProcessEngineService.svc/{ProcessName}/Execute с параметрами через query-string; ' +
      'опционально возвращает значение выходного параметра (result_parameter_name). ' +
      'Пример: {"process_name": "UsrCalcLeadScore", "parameters": {"LeadId": "<uuid>"}, ' +
      '"result_parameter_name": "Score"}. Стандартный путь для сложной серверной логики: агрегации и ' +
      'JOIN-ы через ESQ в Script Task процесса (прямого HTTP-API для ESQ у BPMSoft нет).',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    blurb: 'запустить бизнес-процесс по имени',
    category: 'process',
  },
  {
    name: 'bpm_exec_process_element',
    title: 'Запустить элемент процесса',
    description:
      'Вызывает ProcessEngineService.svc/ExecProcElByUId — возобновляет приостановленный элемент уже ' +
      'выполняющегося процесса (например, пользовательскую задачу). ' +
      'Пример: {"element_uid": "3fa85f64-5717-4562-b3fc-2c963f66afa6"}. ' +
      'Запуск нового процесса с нуля — bpm_run_process.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    blurb: 'запустить элемент уже выполняющегося процесса',
    category: 'process',
  },
  {
    name: 'bpm_post_feed',
    title: 'Опубликовать сообщение в ленту записи',
    description:
      'Публикует сообщение в ленту записи (коллекция SocialMessage) — основной канал комментариев ' +
      'BPMSoft; сообщение видно всем, у кого есть доступ к записи. ' +
      'Пример: {"collection": "Opportunity", "id": "<uuid>", "message": "Клиент согласовал договор", ' +
      '"parent_id": "<uuid ответа>"}. Задача/звонок с исполнителем и сроком — bpm_log_activity.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    blurb: 'опубликовать сообщение в ленту записи',
    category: 'process',
  },
];

export function getTool(name: string): ToolDescriptor {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`Tool not registered in registry: ${name}`);
  return t;
}

export function listToolBlurbs(): string {
  const order: ToolDescriptor['category'][] = ['init', 'read', 'write', 'schema', 'workflow', 'process', 'batch', 'stream'];
  const lines: string[] = [];
  for (const cat of order) {
    const tools = TOOLS.filter((t) => t.category === cat);
    if (tools.length === 0) continue;
    for (const t of tools) {
      lines.push(`  • ${t.name.padEnd(22)} — ${t.blurb}`);
    }
  }
  return lines.join('\n');
}
