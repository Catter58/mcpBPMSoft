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
    name: 'bpm_get_operation',
    title: 'Проверить сохранённый исход операции',
    description:
      'Читает журнал операции текущего пользователя на текущем стенде. Пример: {"operation_id":"<uuid из _meta>","stage_limit":20}. ' +
      'Возвращает состояние, этапы и признаки requires_state_verification/safe_to_retry. ' +
      'Для следующей страницы используйте next_stage_offset; include_receipt=true запрашивает сохранённый ответ. ' +
      'Не повторяет и не продолжает изменения автоматически. outcome_unknown требует проверки данных в BPMSoft. ' +
      'Доступен, когда включён журнал операций; чужие и отсутствующие UUID одинаково возвращают not_found.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'проверить журнал своей операции после сбоя, без повторной записи',
    category: 'read',
  },
  {
    name: 'bpm_init',
    title: 'Подключиться к BPMSoft',
    description:
      'Подключает одиночный stdio-клиент к BPMSoft в явно включённом режиме env-creds. Пример: {"url":"https://crm.example","username":"api-user","password":"<secret>"}. В стандартном HTTP-режиме используется авторизация каждого запроса. После проверки подключения инструменты работают с тем же контейнером сервисов.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'инициализация подключения (URL, логин/пароль, OData v3/4, платформа)',
    category: 'init',
  },

  // ---- READ ----
  {
    name: 'bpm_get_records',
    title: 'Список записей коллекции',
    description:
      'Читает записи OData по известному filter; для русских критериев и нечёткого поиска используйте bpm_search_records. Пример: {"collection":"Contact","filter":"Name eq \'Иванов\'","select":"Id,Name","top":10}. Без select вернутся Id и отображаемое имя; select=\'*\' запрашивает все поля. Lookup включает CityName, отключается resolve_lookups=false. Автопагинация выключена по умолчанию; max_records по умолчанию и максимально 1000, продолжение — по cursor. Текст — до 50 строк, format=\'summary\' оставляет значения только в structuredContent. Ответ содержит records/count/total_count/has_more/cursor; максимум 64 КиБ, response_too_large возвращает отказ без данных. Сужайте filter/select/top.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'получить записи коллекции (фильтр/select/expand/order/top/skip, безопасный лимит)',
    category: 'read',
  },
  {
    name: 'bpm_get_record',
    title: 'Запись по ID',
    description:
      'Читает одну запись по UUID или однозначному названию (Name/Title); при нескольких совпадениях вернёт кандидатов. Пример: {"collection":"Account","id":"Ромашка","select":"Id,Name"}. Поддерживает select/expand; без select возвращает все поля, lookup включает CityName (отключается resolve_lookups=false). Текст содержит непустые поля, полная запись — в structuredContent; исправления коллекции/полей перечисляются в warnings. Необязательный verify сверяет expected после create/update или проверяет отсутствие после delete по точным UUID/коллекции; он только наблюдает текущее состояние и никогда не повторяет запись.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'получить запись по UUID или однозначному названию',
    category: 'read',
  },
  {
    name: 'bpm_count_records',
    title: 'Количество записей',
    description:
      'Считает записи через /$count; условия — criteria из bpm_search_records и/или raw filter. Пример: {"collection":"Activity","criteria":[{"field":"Ответственный","op":"равно","value":"я"}]}. Для сумм/группировок используйте bpm_aggregate. Одним criteria можно задать статус «открыт/закрыт/выиграна/проиграна»; справочник состояния сервер найдёт сам.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'подсчёт записей с опциональным фильтром',
    category: 'read',
  },
  {
    name: 'bpm_search_records',
    title: 'Поиск с критериями (рус.)',
    description:
      'Ищет по criteria без OData: field принимает русские подписи и пути (Account.City), op — русские/OData. Пример: {"collection":"Contact","criteria":[{"field":"Город","op":"равно","value":"Москва"}]}. «содержит» без учёта регистра; similar_to также игнорирует кавычки и орг-формы. Для lookup передавайте имя, не UUID; даты без времени — сутки в часовом поясе пользователя, «я» — текущий пользователь. Поддерживает orderby по подписи, format=\'summary\' (значения только в structuredContent), cursor/has_more и необязательную автопагинацию; max_records по умолчанию и максимально 1000, текст до 50 строк, полный ответ до 64 КиБ. Состояние задаётся одним op «открыт/закрыт/выиграна/проиграна»; сервер сам найдёт справочник статуса.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'поиск по criteria-DSL (RU/EN, авто-резолвинг полей, similar_to)',
    category: 'read',
  },
  {
    name: 'bpm_aggregate',
    title: 'Группировка и итоги',
    description:
      'Считает count/sum/avg/min/max и группирует на сервере без выгрузки строк в контекст. Пример: {"collection":"Opportunity","criteria":[{"field":"Ответственный","op":"равно","value":"я"}],"group_by":"Стадия","metrics":[{"op":"sum","field":"Amount"}]}. date_field+bucket поддерживают день/неделю/месяц/квартал/год в часовом поясе пользователя; period ограничивает даты, compare_previous добавляет изменения count и каждой метрики по группам, включая разницу, процент и вклад count/sum. Значения и дельты метрик округляются до 12 знаков, проценты — до 6; нулевая база и неприменимый вклад отмечаются null_reasons. При неполном скане metric_comparison_scope=observed_scan, иначе global. cohorts сравнивает от 2 до 5 именованных выборок одной коллекции; compare задаёт baseline/comparison и добавляет разницу, процент изменения и долю суммы для sum-метрик. Когорты могут пересекаться, запись учитывается в каждой совпавшей выборке. max_records по умолчанию 10000; при усечении complete=false/truncated=true. Для точных Decimal/Int64 используйте bpm_aggregate_records.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'группировка и итоги (count/sum/avg/min/max) на сервере',
    category: 'read',
  },
  {
    name: 'bpm_record_card',
    title: 'Карточка записи 360°',
    description:
      'Показывает заполненные поля записи, связанные имена, последние активности/сделки/обращения, файлы, ленту и счётчики за один вызов. Укажите id (UUID/название) или match_by с 1–8 точными бизнес-полями и уникальным результатом. Пример: {"collection":"Account","match_by":[{"field":"ExternalCode","value":"A-17"}]}. Для точечных выборок используйте bpm_search_records.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'карточка 360°: запись + связанные активности, сделки, файлы, лента',
    category: 'read',
  },
  {
    name: 'bpm_find_duplicates',
    title: 'Поиск дублей',
    description:
      'Ищет возможные дубли по коллекции или условию, сравнивая нормализованные имена/ФИО, email, телефоны, ИНН и домен; конфликты снижают оценку. Пример: {"collection":"Contact","min_level":"likely"}. Возвращает exact/likely/possible, причины, рекомендуемую основную запись и число связей. Укажите поля группировки для exact ключа; complete/scanned_count показывают полноту. Слияние — bpm_merge_duplicates.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'поиск дублей: ФИО/названия, email, телефоны, ИНН, сайт — группы с причинами',
    category: 'read',
  },
  {
    name: 'bpm_check_duplicates',
    title: 'Проверка на дубль до создания',
    description:
      'Перед созданием проверяет похожие существующие записи по тем же данным, что bpm_create_record. Пример: {"collection":"Account","data":{"Name":"Ромашка","Phone":"+7 916 123-45-67"}}. Возвращает кандидатов, оценку и причины; вызывайте для контактов, контрагентов или лидов до создания.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'есть ли уже такая запись — до создания',
    category: 'read',
  },
  {
    name: 'bpm_merge_duplicates',
    title: 'Слияние дублей',
    description:
      'Сначала строит план слияния: поля для переноса, ссылки для перепривязки и записи для удаления; без confirm=true данные не меняются. Пример: {"collection":"Contact","master_id":"<uuid>","duplicate_ids":["<uuid>"]}. Покажите план и дождитесь явного подтверждения; затем передайте confirm=true и expected_references из плана. Удаление дубля произойдёт только после успешной перепривязки; ответ содержит снимок удалённой записи.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    blurb: 'слияние дублей: план → подтверждение, перепривязка всех ссылок',
    category: 'write',
  },

  {
    name: 'bpm_whoami',
    title: 'Кто я и сколько времени',
    description:
      'Показывает пользователя текущей сессии и время в его часовом поясе. Пример: {}. Для criteria/data со значением «я» отдельный вызов не нужен: сервер сам разрешает пользователя; «сегодня» и периоды считаются в его поясе.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'текущий пользователь, его контакт и текущее время в его поясе',
    category: 'read',
  },

  {
    name: 'bpm_aggregate_records',
    title: 'Подсчёт и группировка',
    description:
      'Считает на сервере count/sum/avg и группирует; точные Decimal/Int64 сохраняются. Пример: {"collection":"Opportunity","group_by":["Стадия"],"metrics":[{"field":"Amount","op":"sum","alias":"revenue"}],"rank_by":"revenue","rank_direction":"desc","max_groups":10}. rank_by принимает count или псевдоним метрики; rank_direction требует rank_by. При неполном скане ranking_scope=observed_scan, то есть рейтинг покрывает только просмотренные записи; cohorts можно ранжировать только по count. date_field вместе с bucket добавляет день/неделю/месяц/год (неделя начинается в понедельник); возвращаемое имя измерения указано в bucket_field. Edm.Date группируется по дате UTC, DateTime — в часовом поясе пользователя. max_records и max_groups ограничивают скан и группы; complete/has_more/truncated_groups показывают полноту.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'серверные группировки и точные числовые показатели',
    category: 'read',
  },

  // ---- WRITE ----
  {
    name: 'bpm_create_record',
    title: 'Создать запись',
    description:
      'Создаёт одну запись, разрешая имена полей и lookup по подписи, и проверяет обязательные поля до POST. dry_run=true выполняет ту же подготовку без записи и возвращает ready, blockers и normalized_args; value_origins показывает для каждого поля, пришло ли значение от пользователя, было приведено/разрешено, вычислено или ожидается от платформы, и известно ли оно в подготовке. Значение server default с observed=false не является подтверждённым значением записи. clarifications может содержать choices с готовым argument_patch. Пример ответа: {"clarifications":[{"field":"AccountId","choices":[{"label":"Ланит — <uuid>","value":"<uuid>","argument_patch":{"data":{"AccountId":"<uuid>"}}}]}]}. После уточнения примените выбранный patch к данным вызова и повторите dry_run либо передайте исправленный normalized_args без dry_run. Неточные lookup указаны в resolved_lookups; неоднозначный lookup завершится lookup_ambiguous. idempotency_key защищает повтор от дубля; idempotency_scope=user сохраняет ключ между сессиями для того же инстанса, арендатора и пользователя BPMSoft и требует ключ, по умолчанию используется session. Для нескольких записей — bpm_batch_create.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    blurb: 'создать запись (с авторезолвингом lookup-полей)',
    category: 'write',
  },
  {
    name: 'bpm_update_record',
    title: 'Обновить запись',
    description:
      'Обновляет одну запись после проверки полей, типов и однозначных lookup; укажите id (UUID или однозначное имя) либо match_by — массив из 1–8 точных бизнес-полей, объединённых AND. match_by допускает только уникальный результат и при неоднозначности блокирует запись. dry_run=true читает запись и возвращает blockers, before/after и normalized_args с абсолютным data-patch; value_origins показывает источник и наблюдаемость каждого значения. clarifications может предложить готовый argument_patch, например {"data":{"StatusId":"<uuid>"}}. Примените выбранный patch и повторно подготовьте вызов; не повторяйте исходные operations, иначе относительное изменение применится ещё раз. Пример: {"collection":"<collection>","match_by":[{"field":"ExternalCode","value":"A-17"}],"operations":[{"field":"Score","op":"increment","amount":1}]}. Поддерживаются add/increment/percent_change, shift_date и set_if_empty; ETag не гарантирует атомарность на всех инстансах. При stale-конфликте просмотрите изменённые поля и подтвердите новый preview/token отдельно. При outcome_unknown используйте verification_args с bpm_get_record.verify для точного UUID и не повторяйте запись автоматически; наблюдение не доказывает причинность. Для массовых правок — bpm_batch_update.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    blurb: 'обновить запись по UUID',
    category: 'write',
  },
  {
    name: 'bpm_delete_record',
    title: 'Удалить запись',
    description:
      'Двухшаговое удаление одной записи: укажите id или match_by с 1–8 точными бизнес-полями; сначала получите preview и confirmation_token, затем подтвердите показанную запись. match_by требует единственного совпадения. Пример: {"collection":"Contact","match_by":[{"field":"ExternalCode","value":"A-17"}]}. Токен одноразовый, привязан к пользователю, подключению, записи и содержимому; срок — 10 минут. expected_etag действует только при поддержке платформой.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    blurb: 'удалить запись по UUID (требует confirm=true)',
    category: 'write',
  },
  {
    name: 'bpm_update_by_filter',
    title: 'Обновить по фильтру',
    description:
      'Обновляет до 1000 записей только после трёх шагов: без expected_count первый вызов показывает найденное число/записи без изменений; expected_count формирует точный план и confirmation_token; после показа плана и явного подтверждения повторите те же параметры с confirm=true и токеном. Пример: {"collection":"Account","filter":"Name eq \'Ромашка\'","data":{"Phone":"123"},"expected_count":1}. Критерии поддерживают русские подписи; изменение набора/данных отменяет план. Если данные записи изменились, проверьте conflict.changed и новый preview/token, затем получите отдельное подтверждение. Итог содержит частичные ошибки.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    blurb: 'массовое обновление по фильтру (с защитным expected_count)',
    category: 'write',
  },
  {
    name: 'bpm_delete_by_filter',
    title: 'Удалить по фильтру',
    description:
      'Готовит план удаления точного набора до 1000 записей, сверяя expected_count и все страницы. Пример: {"collection":"Activity","filter":"Title eq \'Example\'","expected_count":2}. Укажите либо criteria, либо filter. До записи покажите список и получите явное подтверждение; затем повторите параметры с confirm=true и confirmation_token. Токен привязан к IDs/содержимому, одного совпадения количества недостаточно. При изменении содержимого получите обновлённый план и отдельное подтверждение; ничего не удаляется автоматически. Итог содержит выполненные, ошибочные и невыполненные действия.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    blurb: 'массовое удаление по фильтру (expected_count + confirm=true)',
    category: 'write',
  },

  // ---- SCHEMA / LOOKUP ----
  {
    name: 'bpm_get_collections',
    title: 'Список коллекций',
    description:
      'Перечисляет доступные EntitySet из $metadata; при большом числе выдача ограничена limit (по умолчанию 100) и содержит total/has_more. Пример: {"pattern":"Contact","limit":20}. Сужайте pattern; если имя коллекции не найдено, проверьте здесь. Для обзора инстанса — bpm_describe_instance.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'список доступных коллекций',
    category: 'schema',
  },
  {
    name: 'bpm_get_schema',
    title: 'Схема коллекции',
    description:
      'Возвращает поля, типы, обязательность, lookup-связи и русские подписи коллекции. Пример: {"collection":"Contact"}. Перед созданием проверьте caller_required_fields/default_hint; required и nullable различаются. requirements_complete/unknown_requirement_fields сообщают о неполных данных. Поиск одного поля — bpm_find_field.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'схема коллекции (поля, типы, lookup, рус. подписи)',
    category: 'schema',
  },
  {
    name: 'bpm_lookup_value',
    title: 'Найти UUID по значению',
    description:
      'Возвращает UUID справочного значения только при доказанном однозначном точном/нормализованном совпадении. Пример: {"collection":"Account","field":"Name","value":"Ланит"}. При нечётком совпадении показывает кандидатов и точные UUID, но не выбирает похожий префикс автоматически. Для enum используйте bpm_get_enum_values; read/write-инструменты сами разрешают lookup.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'найти UUID по тексту (нечёткий каскад: кавычки/орг-формы/регистр)',
    category: 'schema',
  },
  {
    name: 'bpm_get_enum_values',
    title: 'Значения справочника поля',
    description:
      'Показывает Id и названия значений справочника lookup-поля; field принимает имя или русскую подпись. Пример: {"collection":"Activity","field":"Тип активности"}. Используйте для показа вариантов; create_record сам сопоставит текст и при ошибке вернёт допустимые значения.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'значения справочника для lookup-поля',
    category: 'schema',
  },
  {
    name: 'bpm_workflow_catalog',
    title: 'Каталог типичных сценариев',
    description:
      'Даёт карту типичных сценариев, рекомендуемые инструменты, связи и известные ограничения MCP. Пример: {"scenario_id":"mass-delete"} (или {} для всего каталога). Это ориентир: коллекции, поля и бизнес-правила зависят от инстанса; проверяйте bpm_describe_instance, bpm_get_collections и bpm_get_schema.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    blurb: 'каталог сценариев и карта сущностей',
    category: 'schema',
  },
  {
    name: 'bpm_find_field',
    title: 'Поиск поля по подписи',
    description:
      'Ищет поле по русскому/английскому фрагменту в загруженных схемах. Пример: {"search":"ИНН","collection":"Account"}. Если схема не загружена, collection загрузится автоматически; без неё поиск ограничен кешем. Полная схема — bpm_get_schema.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'поиск поля по подписи (RU/EN)',
    category: 'schema',
  },
  {
    name: 'bpm_get_relations',
    title: 'Связи между объектами',
    description:
      'Показывает исходящие lookup и входящие ссылки; с target строит кратчайший путь для criteria/OData. Пример: {"collection":"Контакт","target":"Сделка"}. Пути строятся от query_collection; через промежуточную запись вернётся подсказка в два шага. Точный probe_record_id дополнительно проверяет ограниченные прямые read paths для этой записи; direction/target ограничивают проверяемые связи. Возвращаются capability, observed result и точные аргументы существующего read-инструмента только когда ответ можно интерпретировать. Возможности кэшируются по инстансу, identity и пути; root проверяется заново. Для входящих expand/exists требуется точный EDMX Partner; многозвенные пути остаются metadata-only и unverified. Не включает CreatedBy/ModifiedBy.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'связи объекта и пути между объектами для построения запросов',
    category: 'schema',
  },
  {
    name: 'bpm_describe_instance',
    title: 'Краткая сводка по инстансу BPMSoft',
    description:
      'Одним вызовом показывает обзор инстанса: основные сущности, число коллекций, записи и кастомные Usr*-поля/коллекции. Пример: {}. Ответ кешируется 5 минут. Используйте при знакомстве с инстансом; сценарный ориентир — bpm_workflow_catalog.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'обзор инстанса (главные сущности, кастомные коллекции/поля)',
    category: 'schema',
  },

  // ---- BATCH ----
  {
    name: 'bpm_batch_create',
    title: 'Пакетное создание',
    description:
      'Создаёт до 1000 записей одним вызовом — не запускайте серию/параллельные create_record. Режим records принимает collection+records. Для связанной цепочки используйте steps вида {"steps":[{"alias":"account","collection":"Account","record":{"Name":"А"}},{"alias":"contact","collection":"Contact","record":{"Name":"Б","AccountId":{"$ref":"account"}}}]}; $ref допустим только в GUID lookup на коллекцию указанного alias, шаги выполняются после зависимостей, циклы запрещены. dry_run=true подготовит все строки и вернёт normalized_args до записи; value_origins показывает источник каждого значения, включая ссылки шагов и сгенерированные Id. Значения платформенных defaults с observed=false не означают, что их итоговое значение известно. idempotency_scope=user с idempotency_key стабилен между сессиями того же BPMSoft-пользователя/арендатора/инстанса; session остаётся значением по умолчанию. Сервер выбирает $batch или последовательную отправку; continue_on_error=true пропускает ошибочные строки. match_on + if_exists управляет существующими записями. Lookup по именам; даты/числа приводятся к типам. Строки OrderProduct/InvoiceProduct/OpportunityProductInterest дополняются, суммы заказа/счёта пересчитываются.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    blurb: 'пакетное создание (сервер сам выбирает $batch или по одному)',
    category: 'batch',
  },
  {
    name: 'bpm_batch_update',
    title: 'Пакетное обновление',
    description:
      'Готовит пакетное обновление OData v3/v4 и возвращает записи, изменения и confirmation_token; для каждой строки укажите id (UUID/однозначное имя) либо match_by из 1–8 точных полей. Пример: {"collection":"Contact","updates":[{"match_by":[{"field":"ExternalCode","value":"A-17"}],"data":{"Phone":"123"}}]}. Относительные operations разрешаются в абсолютный data; после stale-конфликта сервер возвращает изменившиеся поля, новый preview/token и не пишет до нового подтверждения. value_origins показывает источники значений. При неоднозначных полях clarifications может предложить choices и argument_patch. После частичного результата используйте только возвращённые retry_args/safe_retry_indices для безопасно не выполненных строк; outcome_unknown сначала проверяйте по verification_args через read-only bpm_get_record.verify. Не повторяйте всю исходную пачку: batch не транзакция, ETag зависит от платформы.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    blurb: 'пакетное обновление',
    category: 'batch',
  },
  {
    name: 'bpm_batch_delete',
    title: 'Пакетное удаление',
    description:
      'Готовит удаление выбранных UUID (или однозначных названий) и preview с confirmation_token. Пример: {"collection":"Contact","ids":["<uuid>"]}. После показа списка получите явное подтверждение и повторите те же IDs с confirm=true и токеном. Сервер выбирает batch/sequential (mode); изменение набора отклоняется, изменение снимка тех же записей возвращает поля до/после и новый план без удаления. Для каждого ID указан succeeded/failed/not_executed/outcome_unknown; сначала проверьте состояние при неизвестном исходе, не повторяйте вслепую. Результаты связаны request_id.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    blurb: 'пакетное удаление (требует confirm=true)',
    category: 'batch',
  },

  // ---- STREAM ----
  {
    name: 'bpm_upload_file',
    title: 'Загрузить файл в SysImage',
    description:
      'Загружает файл в SysImage и при необходимости привязывает к записи. Пример: {"content_base64":"<base64>","name":"photo.gif"}. Передавайте реальные байты изображения: имя/MIME не меняют содержимое. Для привязки задайте все target_collection/target_id/target_field. Можно передать content_base64+name или file_path; в stdio путь читается на хосте MCP, в HTTP он должен разрешиться внутри личного каталога аутентифицированного пользователя на выбранном стенде (относительный путь считается от него; вне каталога отказ). image_id/idempotency_key фиксирует UUID; частичный ответ сохраняет выполненные шаги. Для произвольного бинарного поля — bpm_field_upload.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    blurb: 'загрузить файл (через SysImage)',
    category: 'stream',
  },
  {
    name: 'bpm_download_file',
    title: 'Скачать файл из SysImage',
    description:
      'Скачивает данные SysImage по UUID. Пример: {"image_id":"<uuid>","return_base64":true}. return_base64 помещает данные в structuredContent.content_base64 (с лимитом); save_path сохраняет на хост MCP в stdio или личном каталоге. Без этих параметров вернутся метаданные и размер. Для бинарного поля — bpm_field_download.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'скачать файл из SysImage',
    category: 'stream',
  },
  {
    name: 'bpm_field_upload',
    title: 'Загрузить бинарь в поле',
    description:
      'Записывает бинарные данные напрямую в поле сущности; для общего хранилища используйте bpm_upload_file. Пример: {"collection":"Contact","id":"<uuid>","field":"Photo","content_base64":"<base64>"}. Принимает content_base64 или file_path; в stdio путь читается на хосте MCP, в HTTP должен разрешиться внутри личного каталога аутентифицированного пользователя на выбранном стенде. id — UUID или название.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    blurb: 'PUT бинарь в поле сущности',
    category: 'stream',
  },
  {
    name: 'bpm_field_download',
    title: 'Скачать бинарь из поля',
    description:
      'Читает бинарные данные поля сущности. Пример: {"collection":"Contact","id":"<uuid>","field":"Photo","return_base64":true}. return_base64 помещает данные в structuredContent.content_base64 с лимитом; save_path сохраняет файл на хост MCP (stdio или личный каталог). Без них вернётся размер. id — UUID или название.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'GET бинарь из поля сущности',
    category: 'stream',
  },
  {
    name: 'bpm_field_delete',
    title: 'Очистить бинарное поле',
    description:
      'Двухшагово очищает бинарное поле конкретной записи. Пример: {"collection":"Contact","id":"<uuid>","field":"Photo"}. Сначала покажите preview и получите явное подтверждение; для выполнения передайте confirm=true и confirmation_token, привязанный к записи/полю. Для удаления самой записи — bpm_delete_record.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    blurb: 'DELETE бинарь в поле сущности (требует confirm=true)',
    category: 'stream',
  },

  // ---- WORKFLOW (composite scenarios on top of CRUD) ----
  {
    name: 'bpm_register_contact',
    title: 'Зарегистрировать контакт',
    description:
      'Проверяет существующий контакт по email/имени и требования до записи; при необходимости находит или создаёт контрагента. Пример: {"name":"Иванов Иван","account_name":"Ромашка","idempotency_key":"<key>"}. Неоднозначную связь уточните до записи. Частичный ответ сохраняет UUID и шаги; account_id позволяет продолжить безопасно.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    blurb: 'регистрация контакта (+ привязка к контрагенту по имени)',
    category: 'workflow',
  },
  {
    name: 'bpm_log_activity',
    title: 'Зафиксировать активность',
    description:
      'Создаёт активность после проверки типа, категории, статуса, владельца, интервала и связи. title обязателен. Раздельные поля: activity_type, category, status, start_date, end_date или due_date (срок означает завершение), duration_minutes и owner_name; legacy type остаётся псевдонимом category. Пример: {"title":"Позвонить клиенту","activity_type":"Задача","category":"Выполнить","start_date":"завтра","duration_minutes":30,"owner_name":"Петров","related_collection":"Account","related_id":"<uuid>"}. Дата без времени выбирает первый свободный слот владельца с 09:00 до 18:00 в его часовом поясе; стандартная длительность — 30 минут. Явное время имеет приоритет. dry_run=true проверяет поля без POST и возвращает blockers, source_timezone и точные normalized_args с idempotency_key для повторения. Проверка занятости основана на снимке и не резервирует слот для параллельного запроса. Неполная проверка занятости или неизвестный владелец отменяют создание; комментарий публикуйте через bpm_post_feed.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    blurb: 'создать активность (тип/владелец/связь резолвятся по тексту)',
    category: 'workflow',
  },
  {
    name: 'bpm_set_status',
    title: 'Установить статус записи',
    description:
      'Меняет статус, находя поле и однозначное значение справочника. Пример: {"collection":"Activity","id":"<uuid>","status":"Завершена"}. Если подходят несколько полей, задайте status_field; ошибки выбора возникают до записи. expected_etag необязателен и требует поддержки платформы. Другие изменения — bpm_update_record.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    blurb: 'установить статус по имени (Status/Stage авто-детект)',
    category: 'workflow',
  },
  {
    name: 'bpm_my_agenda',
    title: 'Моя повестка',
    description:
      'Показывает незавершённые активности текущего пользователя: overdue/today/upcoming (по умолчанию следующие 7 дней, в его часовом поясе) и опционально stale сделки. Пример: {"days":7,"stale_days":14}. owner выбирает другого сотрудника по ФИО. Ответ: overdue/today/upcoming/stale.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'мои задачи: просроченные, сегодня, ближайшие дни; зависшие сделки',
    category: 'workflow',
  },
  {
    name: 'bpm_search_unified',
    title: 'Сквозной поиск',
    description:
      'Ищет по имени/заголовку в нескольких коллекциях и возвращает карточки отдельно от достоверных counts. Пример: {"query":"Иванов","collections":["Contact","Account"],"top":5}. Для точного набора строковых полей задайте fields_by_collection, например {"Account":["ИНН","Name"]}; без collections его ключи выбирают коллекции. match_mode=exact ищет полное значение, contains ищет подстроку. Явные поля проверяются по метаданным и не расширяются core-фолбэком. Ответ показывает matched_fields, число уникальных пар (коллекция, Id), серверные итоги по каждой коллекции и неполное покрытие; has_more/cursors_by_collection позволяют продолжить чтение. Ошибка коллекции не считается нулём.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'сквозной поиск по Name (нечёткий фолбэк по ядру имени)',
    category: 'workflow',
  },

  // ---- PROCESS / FEED (BPMSoft outside OData) ----
  {
    name: 'bpm_run_process',
    title: 'Запустить бизнес-процесс',
    description:
      'Вызывает ProcessEngineService Execute с параметрами; первый вызов возвращает план и confirmation_token. Пример: {"process_name":"UsrCalcLeadScore","parameters":{"LeadId":"<uuid>"}}. Покажите план, дождитесь явного подтверждения, затем повторите те же параметры с confirm=true и токеном. При неизвестном исходе автоматического повтора нет: проверьте состояние процесса в BPMSoft перед новой попыткой.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    blurb: 'запустить бизнес-процесс по имени',
    category: 'process',
  },
  {
    name: 'bpm_exec_process_element',
    title: 'Запустить элемент процесса',
    description:
      'Возобновляет приостановленный элемент существующего процесса (например, user task), не запускает новый процесс. Пример: {"element_uid":"<uuid>"}. Сначала покажите план; выполнение требует явного подтверждения и одноразового confirmation_token с confirm=true. При сетевом сбое проверьте состояние, не повторяйте автоматически. Новый запуск — bpm_run_process.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    blurb: 'запустить элемент уже выполняющегося процесса',
    category: 'process',
  },
  {
    name: 'bpm_post_feed',
    title: 'Опубликовать сообщение в ленту записи',
    description:
      'Публикует комментарий в SocialMessage для записи; его видят все пользователи с доступом. Пример: {"collection":"Opportunity","id":"<uuid>","message":"Клиент согласовал договор"}. id — UUID или название. Для задачи/звонка с исполнителем и сроком используйте bpm_log_activity.',
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
  const order: ToolDescriptor['category'][] = [
    'init',
    'read',
    'write',
    'schema',
    'workflow',
    'process',
    'batch',
    'stream',
  ];
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
