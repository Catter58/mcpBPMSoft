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
      'Без select возвращаются только Id и колонка отображения (Name/Title/...) — защита контекста LLM; ' +
      "все колонки — по select='*', конкретные — списком через запятую. " +
      'В lookup-колонках рядом с CityId приходит CityName (отключается resolve_lookups=false). ' +
      'По умолчанию автопагинация выключена и действует лимит max_records≈1000; ' +
      'продолжение — по cursor из ответа. Ответ: records + count/total_count/has_more/cursor.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'получить записи коллекции (фильтр/select/expand/order/top/skip, безопасный лимит)',
    category: 'read',
  },
  {
    name: 'bpm_get_record',
    title: 'Запись по ID',
    description:
      'Возвращает одну запись коллекции по UUID или названию с опциональными $select и $expand. ' +
      'Пример: {"collection": "Account", "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6", "expand": "PrimaryContact"}. ' +
      "Без select приходят только Id и колонка отображения (Name/Title/...); все колонки — по select='*'. " +
      'В lookup-колонках рядом с CityId приходит CityName (отключается resolve_lookups=false). ' +
      'Вместо UUID можно передать название записи (Name/Title) — сервер найдёт Id сам; при нескольких ' +
      'совпадениях вернёт кандидатов.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'получить запись по UUID',
    category: 'read',
  },
  {
    name: 'bpm_count_records',
    title: 'Количество записей',
    description:
      'Возвращает число записей коллекции через /$count. Условие — criteria как в bpm_search_records ' +
      '(русские подписи, «сегодня», «я») и/или сырой filter. ' +
      'Пример: {"collection": "Activity", "criteria": [{"field": "Ответственный", "op": "равно", "value": "я"}, ' +
      '{"field": "CreatedOn", "op": "на этой неделе"}]}. Для группировки и сумм — bpm_aggregate.',
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
      'орг-формы (АО/ООО/...). Для lookup-колонки можно передавать текст значения — сервер сам ' +
      "сравнит его с именем связанной записи (Type/Name eq 'Сотрудник'), UUID доставать не нужно. " +
      'Сервер компилирует корректный $filter сам — предпочтительнее ' +
      'bpm_get_records с ручным filter. Без select возвращаются только Id и колонка отображения ' +
      "(Name/Title/...), все колонки — по select='*'; в lookup-колонках рядом с CityId приходит CityName. " +
      'Дата без времени («2026-09-14») означает сутки в поясе пользователя; value="я" в lookup на ' +
      'контакт подставляет текущего пользователя; orderby принимает подписи («Контрагент desc»). ' +
      'Ответ: compiled_filter, records, count/total_count/has_more/cursor.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'поиск по criteria-DSL (RU/EN, авто-резолвинг полей, similar_to)',
    category: 'read',
  },
  {
    name: 'bpm_aggregate',
    title: 'Группировка и итоги',
    description:
      'Считает количество, сумму, среднее, минимум и максимум с группировкой — на стороне сервера, ' +
      'без выгрузки записей в контекст. Условие — criteria как в bpm_search_records (или filter). ' +
      'Пример: {"collection": "Opportunity", "criteria": [{"field": "Ответственный", "op": "равно", "value": "я"}], ' +
      '"group_by": "Стадия", "metrics": [{"op": "sum", "field": "Amount"}]}. ' +
      'По времени: date_field + bucket (day/week/month/quarter/year, в поясе пользователя, неделя с понедельника) ' +
      'группирует по интервалам (вместе с group_by); period («на этой неделе», «в прошлом месяце», this_quarter...) ' +
      'ограничивает записи по date_field; compare_previous=true добавляет предыдущий период: ' +
      '{"collection": "Activity", "date_field": "StartDate", "period": "на этой неделе", "bucket": "day", ' +
      '"group_by": "Ответственный", "compare_previous": true}. ' +
      'Lookup-группы подписаны именами (не uuid). Просматривает до max_records записей на период (по умолчанию 10000); ' +
      'при достижении лимита truncated=true. Ответ: groups [{label, bucket, count, metrics, previous_count, delta}], ' +
      'period, previous_period, scanned.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'группировка и итоги (count/sum/avg/min/max) на сервере',
    category: 'read',
  },
  {
    name: 'bpm_record_card',
    title: 'Карточка записи 360°',
    description:
      'Всё о записи одним вызовом: основные заполненные поля с именами связанных записей, последние ' +
      'активности, сделки и обращения, файлы, сообщения ленты и счётчики по связанным объектам. ' +
      'Запись — UUID или название. Пример: {"collection": "Контрагент", "id": "Ромашка"}. ' +
      'Заменяет цепочку bpm_get_record + несколько bpm_search_records; для точечных выборок — bpm_search_records.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'карточка 360°: запись + связанные активности, сделки, файлы, лента',
    category: 'read',
  },
  {
    name: 'bpm_find_duplicates',
    title: 'Поиск дублей',
    description:
      'Ищет дубли по всей коллекции или по условию: контакты, контрагенты, лиды и любые объекты с колонкой ' +
      'названия. Сравнивает нормализованные ФИО и названия (порядок слов, ё/е, инициалы, кавычки, ' +
      'орг-формы ООО/АО/LLC, транслит), email (регистр, точки gmail), телефоны (+7/8, скобки, дефисы, ' +
      'дополнительные номера из средств связи), ИНН и домен сайта; конфликты (разные ИНН или даты рождения) ' +
      'снижают оценку. Возвращает группы дублей с уровнем exact/likely/possible, причинами совпадения, ' +
      'предложенной основной записью и числом связанных записей у каждой. ' +
      'Пример: {"collection": "Контакт", "min_level": "likely"}. Слияние — bpm_merge_duplicates.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'поиск дублей: ФИО/названия, email, телефоны, ИНН, сайт — группы с причинами',
    category: 'read',
  },
  {
    name: 'bpm_check_duplicates',
    title: 'Проверка на дубль до создания',
    description:
      'Проверяет до создания, нет ли уже такой записи: принимает те же data, что bpm_create_record ' +
      '(Name, Email, Phone, ИНН, сайт...), и возвращает похожие существующие записи с оценкой и причинами. ' +
      'Пример: {"collection": "Account", "data": {"Name": "Ромашка", "Phone": "+7 916 123-45-67"}}. ' +
      'Вызывайте перед созданием контакта, контрагента или лида.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'есть ли уже такая запись — до создания',
    category: 'read',
  },
  {
    name: 'bpm_merge_duplicates',
    title: 'Слияние дублей',
    description:
      'Сливает дубли в основную запись. Двухшаговый протокол: без confirm=true возвращает план — какие пустые ' +
      'поля основной записи заполнятся из дублей, сколько связанных записей (активности, сделки, файлы, теги, ' +
      'лента и любые другие ссылки по схеме) будет перепривязано и какие записи удалятся; ничего не меняет. ' +
      'С confirm=true и expected_references из плана заполняет поля, перепривязывает ссылки и удаляет дубль, ' +
      'только если все перепривязки прошли; снимок удалённой записи возвращается в ответе. ' +
      'Пример: {"collection": "Contact", "master_id": "<uuid>", "duplicate_ids": ["<uuid>"], "confirm": true, ' +
      '"expected_references": 7}. Группы дублей и предложенную основную запись даёт bpm_find_duplicates.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    blurb: 'слияние дублей: план → подтверждение, перепривязка всех ссылок',
    category: 'write',
  },

  {
    name: 'bpm_whoami',
    title: 'Кто я и сколько времени',
    description:
      'Возвращает текущего пользователя (SysAdminUnit + привязанный Contact) и текущее время ' +
      'в его часовом поясе. Личность вычисляет сам BPMSoft в сессии вызывающего (макрос DataService), ' +
      'поэтому при per-request авторизации ответ соответствует владельцу cookie/BPMCSRF. ' +
      'Для «мои»/«я» звать его не нужно: в criteria и data значение "я" сервер сам заменяет на ' +
      'текущего пользователя, а «сегодня»/«на этой неделе» считает в его поясе. Полезен, чтобы ' +
      'узнать текущие дату и время или показать пользователю, под кем идёт работа. ' +
      'Пример: {"timezone": "Europe/Moscow"}.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'текущий пользователь, его контакт и текущее время в его поясе',
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
      'lookup_ambiguous со списком (тогда нужен точный текст или UUID). Возвращает созданную запись. ' +
      'Несколько записей — одним вызовом bpm_batch_create.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    blurb: 'создать запись (с авторезолвингом lookup-полей)',
    category: 'write',
  },
  {
    name: 'bpm_update_record',
    title: 'Обновить запись',
    description:
      'Обновляет поля записи по UUID или названию (PATCH). Lookup-поля с текстом разрешаются каскадно, как в ' +
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
      'Удаляет запись по UUID или названию (DELETE). Действие необратимо, протокол двухшаговый: вызов без ' +
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
      'Находит записи по criteria (как в bpm_search_records) или $filter и обновляет каждую (PATCH). ' +
      'Двухшаговый протокол: вызов без expected_count ничего не меняет и возвращает число найденных и их Id; ' +
      'повторный вызов с этим expected_count выполняет обновление, при несовпадении — отмена (expected_count_mismatch). ' +
      'Пример: {"collection": "Case", "criteria": [{"field": "Статус", "op": "равно", "value": "Новое"}], ' +
      '"data": {"OwnerId": "Петров"}, "expected_count": 12}.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    blurb: 'массовое обновление по фильтру (с защитным expected_count)',
    category: 'write',
  },
  {
    name: 'bpm_delete_by_filter',
    title: 'Удалить по фильтру',
    description:
      'Находит записи по criteria (как в bpm_search_records) или $filter и удаляет каждую. Необратимо; ' +
      'двойная защита: (1) без expected_count возвращается только число найденных и их Id, при несовпадении — ' +
      'отмена; (2) без confirm=true — список ID на удаление, само удаление — повторным вызовом с confirm=true ' +
      'после согласия пользователя. ' +
      'Пример: {"collection": "Activity", "criteria": [{"field": "CreatedOn", "op": "меньше", "value": "2020-01-01"}], ' +
      '"expected_count": 5, "confirm": true}.',
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
      'Пример: {"pattern": "Contact"}. На типовом стенде коллекций больше тысячи, поэтому выдача ' +
      'ограничена limit (по умолчанию 100) и сопровождается total/has_more — сужайте поиск через pattern. ' +
      'Первый шаг при ошибке not_found по имени коллекции; обзор инстанса целиком — bpm_describe_instance.',
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
    name: 'bpm_get_relations',
    title: 'Связи между объектами',
    description:
      'Показывает, как объект связан с другими: исходящие lookup-поля (Contact.Account → Account) и ' +
      'входящие ссылки (Activity.Contact → Contact), без системных CreatedBy/ModifiedBy. С target ищет ' +
      'кратчайшие пути между объектами и отдаёт их в виде, готовом для criteria (field "Account.Owner") ' +
      'и для OData ($filter Account/Owner/Id). Пример: {"collection": "Контакт", "target": "Сделка"}. ' +
      'criteria_field и odata_path строятся от query_collection (объекта, в котором искать); путь через ' +
      'промежуточную запись возвращается подсказкой в два шага. ' +
      'Нужен, чтобы спланировать запрос через несколько объектов без чтения схемы целиком. Только OData v4.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'связи объекта и пути между объектами для построения запросов',
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

  // ---- BATCH ----
  {
    name: 'bpm_batch_create',
    title: 'Пакетное создание',
    description:
      'Создаёт несколько записей за один вызов. Когда нужно создать больше одной записи — всегда этот ' +
      'инструмент, а не серия или параллельные вызовы bpm_create_record. Способ отправки сервер выбирает ' +
      'сам: одним $batch, если инстанс его поддерживает (проверяется один раз), иначе по одному запросу; ' +
      'в ответе поле mode. Работает на OData v3 и v4, заранее проверять ничего не нужно. ' +
      'Lookup-поля резолвятся как в bpm_create_record (неточные — в resolved_lookups). ' +
      'Пример: {"collection": "Contact", "records": [{"Name": "А"}, {"Name": "Б"}], "continue_on_error": true}. ' +
      'continue_on_error=true пропускает ошибочные записи вместо остановки. До ~100 записей за вызов.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    blurb: 'пакетное создание (сервер сам выбирает $batch или по одному)',
    category: 'batch',
  },
  {
    name: 'bpm_batch_update',
    title: 'Пакетное обновление',
    description:
      'Обновляет несколько записей за один вызов (вместо серии bpm_update_record). Способ отправки — ' +
      '$batch или по одному запросу — сервер выбирает сам, работает на v3 и v4. ' +
      'Пример: {"collection": "Contact", "updates": [{"id": "<uuid1>", "data": {"Job": "Директор"}}]}. ' +
      'Lookup-поля резолвятся автоматически; continue_on_error пропускает ошибочные элементы. ' +
      'Когда записи отбираются условием, а не списком UUID — bpm_update_by_filter.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    blurb: 'пакетное обновление',
    category: 'batch',
  },
  {
    name: 'bpm_batch_delete',
    title: 'Пакетное удаление',
    description:
      'Удаляет набор записей по UUID за один вызов ($batch или по одному — выбирает сервер). Необратимо; без ' +
      'confirm=true возвращает превью списка ID, удаление — повторным вызовом с confirm=true после ' +
      'согласия пользователя. Пример: {"collection": "Contact", "ids": ["<uuid1>", "<uuid2>"], "confirm": true}. ' +
      'Удаление по условию — bpm_delete_by_filter.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    blurb: 'пакетное удаление (требует confirm=true)',
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
      'Файл с привязкой через общее хранилище — bpm_upload_file. ' +
      'Параметр id принимает UUID или название записи.',
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
      '"save_path": "/tmp/photo.jpg"}. ' +
      'Параметр id принимает UUID или название записи.',
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
      'Пример: {"collection": "Contact", "id": "<uuid>", "field": "Photo", "confirm": true}. ' +
      'Параметр id принимает UUID или название записи.',
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
      'Точечный контроль над полями — обычный bpm_create_record. ' +
      'Перед созданием проверяет дубль (по Email, иначе по ФИО и контрагенту) и при совпадении возвращает already_exists=true без создания; force=true создаёт всё равно. Контрагент ищется нечётко. Должность, которой нет в справочнике Job, сохраняется в JobTitle.',
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
      'Комментарий в ленту записи (без задачи) — bpm_post_feed. ' +
      'owner_name принимает "я"/"@me"; related_id — UUID или название записи.',
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
      'Параметр id принимает UUID или название записи. При нескольких статусных полях по умолчанию ' +
      'берётся StatusId, иначе нужен status_field. Прочие поля — bpm_update_record.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'установить статус по имени (Status/Stage авто-детект)',
    category: 'workflow',
  },
  {
    name: 'bpm_my_agenda',
    title: 'Моя повестка',
    description:
      'Задачи пользователя одним вызовом: просроченные, на сегодня и на ближайшие дни (по умолчанию 7) — ' +
      'незавершённые активности, где он ответственный; границы дней в его часовом поясе. Опционально — ' +
      'сделки без движения дольше stale_days дней. По умолчанию — текущий пользователь, другого сотрудника ' +
      'задаёт owner (ФИО). Пример: {"days": 7, "stale_days": 14}. Ответ: overdue / today / upcoming / stale.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'мои задачи: просроченные, сегодня, ближайшие дни; зависшие сделки',
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
      '"parent_id": "<uuid ответа>"}. Задача/звонок с исполнителем и сроком — bpm_log_activity. ' +
      'Параметр id принимает UUID или название записи.',
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
