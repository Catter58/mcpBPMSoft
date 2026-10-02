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
      'Возвращает записи OData-коллекции с $filter/$select/$orderby/$expand/$top/$skip. ' +
      'Пример: {"collection": "Contact", "filter": "Name eq \'Иванов\'", "select": "Id,Name", "top": 10}. ' +
      'Подходит, когда $filter уже известен; для человекочитаемых критериев, русских названий полей ' +
      'и нечёткого поиска лучше bpm_search_records (сам скомпилирует $filter). ' +
      'Без select возвращаются только Id и колонка отображения (Name/Title/...) — защита контекста LLM; ' +
      "все колонки — по select='*', конкретные — списком через запятую. " +
      'В lookup-колонках рядом с CityId приходит CityName (отключается resolve_lookups=false). ' +
      'По умолчанию автопагинация выключена и действует лимит max_records≈1000; ' +
      'продолжение — по cursor из ответа. Текстовый ответ — до 50 записей, по строке на запись (только ' +
      "непустые поля); остальное — в structuredContent или format='full'. Однозначные опечатки в коллекции и " +
      'полях (ContactCollection на v4, «Контакты», Nmae) исправляются автоматически — см. warnings. ' +
      'Ответ: records + count/total_count/has_more/cursor.',
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
      'Без select приходят все колонки, в lookup-колонках рядом с CityId — CityName (отключается ' +
      'resolve_lookups=false); в тексте ответа только непустые поля, полная запись — в structuredContent. ' +
      'Вместо UUID можно передать название записи (Name/Title) — сервер найдёт Id сам; при нескольких ' +
      'совпадениях вернёт кандидатов. Опечатки в именах коллекции и полей сервер исправляет сам и сообщает в warnings.',
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
      '{"field": "CreatedOn", "op": "на этой неделе"}]}. Для группировки и сумм — bpm_aggregate. ' +
      'Однозначные опечатки в коллекции и полях criteria исправляются автоматически — см. warnings. ' +
      'Состояние записи — одним критерием: op «открыт»/«закрыт»/«выиграна»/«проиграна» (open/closed/won/lost) по полю статуса или стадии или без field — сервер сам найдёт справочник состояния и его признаки (End, IsFinal, FinalStatus, Successful), например {"op": "открыт"}.',
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
      'Текстовый ответ — до 50 записей, по строке на запись; однозначные опечатки в коллекции и полях ' +
      'исправляются автоматически — см. warnings. ' +
      'Ответ: compiled_filter, records, count/total_count/has_more/cursor. ' +
      'Состояние записи — одним критерием: op «открыт»/«закрыт»/«выиграна»/«проиграна» (open/closed/won/lost) по полю статуса или стадии или без field — сервер сам найдёт справочник состояния и его признаки (End, IsFinal, FinalStatus, Successful), например {"op": "открыт"}.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'поиск по criteria-DSL (RU/EN, авто-резолвинг полей, similar_to)',
    category: 'read',
  },
  {
    name: 'bpm_aggregate',
    title: 'Группировка и итоги',
    description:
      'Считает количество, сумму, среднее, минимум и максимум с группировкой — на стороне MCP-сервера, ' +
      'без выгрузки записей в контекст. Условие — criteria как в bpm_search_records (или filter). ' +
      'Пример: {"collection": "Opportunity", "criteria": [{"field": "Ответственный", "op": "равно", "value": "я"}], ' +
      '"group_by": "Стадия", "metrics": [{"op": "sum", "field": "Amount"}]}. ' +
      'По времени: date_field + bucket (day/week/month/quarter/year, в поясе пользователя, неделя с понедельника) ' +
      'группирует по интервалам (вместе с group_by); period («на этой неделе», «в прошлом месяце», this_quarter...) ' +
      'ограничивает записи по date_field; compare_previous=true добавляет предыдущий период: ' +
      '{"collection": "Activity", "date_field": "StartDate", "period": "на этой неделе", "bucket": "day", ' +
      '"group_by": "Ответственный", "compare_previous": true}. ' +
      'Lookup-группы подписаны именами (не uuid). Просматривает до max_records записей на период (по умолчанию 10000); ' +
      'если за лимитом остаются записи, truncated=true. Числовые показатели используют JavaScript Number; ' +
      'для точных сумм Decimal и больших Int64 используйте bpm_aggregate_records. ' +
      'Ответ: groups [{label, bucket, count, metrics, previous_count, delta}], ' +
      'period, previous_period, scanned. ' +
      'Состояние записи — одним критерием: op «открыт»/«закрыт»/«выиграна»/«проиграна» (open/closed/won/lost) по полю статуса или стадии или без field — сервер сам найдёт справочник состояния и его признаки (End, IsFinal, FinalStatus, Successful), например {"op": "открыт"}.',
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
      'Явный fields включает точную группировку по нормализованному совместному ключу с complete и scanned_count. ' +
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

  {
    name: 'bpm_aggregate_records',
    title: 'Подсчёт и группировка',
    description:
      'Выполняет подсчёт, суммы, средние и группировку на сервере без арифметики моделью. Пример: {"collection":"Opportunity","group_by":["Стадия"],"metrics":[{"field":"Amount","op":"sum","alias":"Сумма"}]}. Поля, типы и справочные критерии проверяются по метаданным; суммы Decimal/Int64 сохраняют точность. При превышении max_records результат явно partial: complete=false. Группы содержат исходные значения и человекочитаемые подписи.',
    blurb: 'серверные группировки и точные числовые показатели',
    category: 'read',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },

  // ---- WRITE ----
  {
    name: 'bpm_create_record',
    title: 'Создать запись',
    description:
      'Перед первым созданием bpm_get_schema показывает caller_required_fields и default_hint. Известные обязательные поля проверяются до записи; missing_fields содержит названия и подписи. ' +
      'Создаёт запись в коллекции (POST). Lookup-поля принимают текст вместо UUID — сервер разрешает ' +
      'их каскадно (точное совпадение → нечёткое: кавычки/орг-формы/регистр игнорируются). ' +
      'Пример: {"collection": "Contact", "data": {"Name": "Иванов Иван", "Город": "Москва", "AccountId": "Ланит"}}. ' +
      'Неточно разрешённые поля перечислены в resolved_lookups; при нескольких кандидатах — ошибка ' +
      'lookup_ambiguous со списком (тогда нужен точный текст или UUID). Возвращает созданную запись. ' +
      'Несколько записей — одним вызовом bpm_batch_create. ' +
      'Для строк заказа, счёта и продуктов сделки (OrderProduct, InvoiceProduct, OpportunityProductInterest) сервер сам подставляет название, единицу, налог и цену из продукта или прайс-листа, считает суммы, скидку и налог строки и пересчитывает сумму заказа или счёта — передавайте только продукт, количество и при необходимости цену или скидку.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    blurb: 'создать запись (с авторезолвингом lookup-полей)',
    category: 'write',
  },
  {
    name: 'bpm_update_record',
    title: 'Обновить запись',
    description:
      'Сохранены серверные расчёты строк заказа и счёта, а также поиск UUID по однозначному названию. ' +
      'Обновляет выбранную запись после проверки полей, типов и однозначных справочных ссылок. Пример: {"collection":"Contact","id":"<uuid>","data":{"Город":"Москва"},"expected_etag":"<etag из чтения>"}. expected_etag необязателен; при отсутствии поддержки ETag платформа получает отказ concurrency_unsupported, а не ложную гарантию. Ошибки выбора возвращаются до изменения. Для массовой операции используйте bpm_update_by_filter.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    blurb: 'обновить запись по UUID',
    category: 'write',
  },
  {
    name: 'bpm_delete_record',
    title: 'Удалить запись',
    description:
      'Подготавливает удаление конкретной записи и возвращает её название и confirmation_token. Пример первого вызова: {"collection":"Contact","id":"<uuid>"}. Выполнение: те же параметры плюс {"confirm":true,"confirmation_token":"<token>"}. Токен однократный, привязан к пользователю, подключению, записи и её содержимому; устаревает через 10 минут. expected_etag используется только при поддержке платформой.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    blurb: 'удалить запись по UUID (требует confirm=true)',
    category: 'write',
  },
  {
    name: 'bpm_update_by_filter',
    title: 'Обновить по фильтру',
    description:
      'Подготавливает массовое обновление до 1000 конкретных записей. Передайте criteria с русскими подписями и значениями справочников; сервер составит фильтр, проверит количество и данные, вернёт IDs, названия и confirmation_token. Пример: {"collection":"Account","filter":"Name eq \'Example\'","data":{"Phone":"123"},"expected_count":1}. Выполнение требует тех же параметров, confirm=true и полученного confirmation_token. Изменение набора или содержимого до подтверждения отменяет операцию. Итог содержит результаты каждого шага и частичные ошибки.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    blurb: 'массовое обновление по фильтру (с защитным expected_count)',
    category: 'write',
  },
  {
    name: 'bpm_delete_by_filter',
    title: 'Удалить по фильтру',
    description:
      'Подготавливает удаление точного набора до 1000 записей, проверяет expected_count и все страницы. Для выборки передайте criteria без ручного OData либо готовый filter, только один из двух. Пример: {"collection":"Activity","filter":"Title eq \'Example\'","expected_count":2}. Для выполнения передайте те же параметры плюс confirm=true и confirmation_token из превью. Токен привязан к IDs и содержимому; одинаковое количество других записей не считается подтверждением. Итог перечисляет выполненные, ошибочные и невыполненные действия.',
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
      '(из описания EntitySchemaDesigner, когда доступно). Пример: {"collection": "Contact"}. ' +
      'Перед первым созданием проверьте caller_required_fields и default_hint; required отделено от nullable. ' +
      'requirements_complete и unknown_requirement_fields показывают неполноту сведений; ' +
      'поиск поля по подписи без загрузки всей схемы — bpm_find_field.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'схема коллекции (поля, типы, lookup, рус. подписи)',
    category: 'schema',
  },
  {
    name: 'bpm_lookup_value',
    title: 'Найти UUID по значению',
    description:
      'Ищет значение справочника и возвращает UUID только при доказанном однозначном точном или нормализованном совпадении. Пример: {"collection":"Account","field":"Name","value":"Ланит"}. Нечёткий поиск предлагает кандидатов с точными именами и UUID; похожий префикс или подстрока не выбираются автоматически. Для значений поля конкретной сущности используйте bpm_get_enum_values; поиск и запись уже выполняют разрешение ссылок самостоятельно.',
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
      'field принимает и русскую подпись («Тип активности»). Для показа вариантов пользователю; перед ' +
      'bpm_create_record не нужен — запись сама сопоставит текст и при промахе вернёт допустимые значения.',
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
      'Сохранены match_on и if_exists для серверного поиска существующей записи; сервер выбирает batch или последовательное выполнение. ' +
      'Создаёт несколько записей за один вызов. Когда нужно создать больше одной записи — всегда этот ' +
      'инструмент, а не серия или параллельные вызовы bpm_create_record. Способ отправки сервер выбирает ' +
      'сам: одним $batch, если инстанс его поддерживает (результат проверки временно кешируется), иначе по одному запросу; ' +
      'в ответе поле mode. Работает на OData v3 и v4, заранее проверять ничего не нужно. ' +
      'Lookup-поля резолвятся как в bpm_create_record (неточные — в resolved_lookups). ' +
      'Пример: {"collection": "Contact", "records": [{"Name": "А"}, {"Name": "Б"}], "continue_on_error": true}. ' +
      'continue_on_error=true: запись с ошибкой пропускается и попадает в отчёт по номеру, остальные создаются; ' +
      'без него при ошибке подготовки ничего не отправляется. Даты, числа и да/нет можно писать как человек ' +
      '(«25.09.2026 15:00», «1 500,50») — сервер приведёт к типу колонки. Ответ: «#n <название> → Id» по каждой ' +
      'записи; created[] выровнен по индексу входа. Против дублей: match_on — колонки, по которым запись уже ' +
      'существует (например ["Name"] или ["Email"], без учёта регистра), и if_exists: skip (по умолчанию, в ответе ' +
      '«уже есть: Id»), update (обновить найденную) или error. Пример: {"collection": "Account", "records": [...], ' +
      '"match_on": ["Name"]}. До ~100 записей за вызов. ' +
      'Строки заказа, счёта и продуктов сделки дополняются и рассчитываются так же, как в bpm_create_record; сумма каждого затронутого заказа или счёта пересчитывается один раз после записи.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    blurb: 'пакетное создание (сервер сам выбирает $batch или по одному)',
    category: 'batch',
  },
  {
    name: 'bpm_batch_update',
    title: 'Пакетное обновление',
    description:
      'UUID можно задавать однозначным названием; строки заказа и счёта дополняются и пересчитываются сервером. ' +
      'Готовит пакет обновлений OData v3/v4 и возвращает конкретные записи, изменения и confirmation_token. Сервер выбирает нативный $batch или последовательные запросы; выбранный режим возвращается в mode. Пример: {"collection":"Contact","updates":[{"id":"<uuid>","data":{"Phone":"123"}}]}. Для выполнения повторите те же параметры с confirm=true и confirmation_token. expected_etag требует поддержки платформой. Итог сохраняет результаты каждой операции, включая частичные и неизвестные исходы; continue_on_error=false останавливает следующие порции после ошибки.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    blurb: 'пакетное обновление',
    category: 'batch',
  },
  {
    name: 'bpm_batch_delete',
    title: 'Пакетное удаление',
    description:
      'UUID можно задавать однозначным названием, которое сервер проверяет до preview. ' +
      'Подготавливает удаление набора UUID OData v3/v4, возвращая названия и confirmation_token. Сервер выбирает нативный $batch или последовательные запросы; выбранный режим возвращается в mode. Пример: {"collection":"Contact","ids":["<uuid>"]}. Выполнение требует тех же IDs плюс confirm=true и token из превью. Любое изменение набора/содержимого отвергается до записи. Каждый входной UUID получает результат succeeded, failed, not_executed или outcome_unknown; ответы связываются по request_id.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    blurb: 'пакетное удаление (требует confirm=true)',
    category: 'batch',
  },

  // ---- STREAM ----
  {
    name: 'bpm_upload_file',
    title: 'Загрузить файл в SysImage',
    description:
      'Загружает файл в хранилище SysImage (метаданные + бинарные данные) и опционально привязывает его ' +
      'к записи. Содержимое — content_base64 (с обязательным name) или file_path; file_path работает только ' +
      'в stdio-режиме или внутри каталога BPMSOFT_FILE_ROOT на хосте MCP-сервера. ' +
      'Пример: {"content_base64": "<base64 настоящего GIF>", "name": "photo.gif", "target_collection": "Contact", ' +
      '"target_id": "<uuid>", "target_field": "PhotoId"} — все три target-параметра вместе. ' +
      'Для полей изображений передавайте настоящее изображение: имя файла и MIME-тип не меняют формат содержимого. ' +
      'image_id или idempotency_key закрепляют UUID загрузки. При частичном результате возвращаются выполненные шаги и UUID для продолжения. В HTTP file_path находится внутри BPMSOFT_FILE_ROOT. ' +
      'Для других бинарных полей сущностей используйте bpm_field_upload; допустимый формат зависит от поля и правил платформы.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    blurb: 'загрузить файл (через SysImage)',
    category: 'stream',
  },
  {
    name: 'bpm_download_file',
    title: 'Скачать файл из SysImage',
    description:
      'Скачивает бинарные данные из SysImage по UUID. return_base64=true возвращает содержимое в ' +
      'structuredContent.content_base64 (в пределах лимита размера); save_path сохраняет на хост MCP-сервера ' +
      '(только stdio-режим или внутри BPMSOFT_FILE_ROOT); без них — метаданные и размер. ' +
      'Пример: {"image_id": "<uuid>", "return_base64": true}. ' +
      'Чтение произвольного бинарного поля сущности — bpm_field_download.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'скачать файл из SysImage',
    category: 'stream',
  },
  {
    name: 'bpm_field_upload',
    title: 'Загрузить бинарь в поле',
    description:
      'PUT бинарных данных напрямую в поле сущности ({Collection}({id})/{Field}) — для произвольных ' +
      'бинарных полей, не только SysImage. Содержимое — content_base64 или file_path (file_path — только ' +
      'stdio-режим или внутри BPMSOFT_FILE_ROOT). ' +
      'Пример: {"collection": "Contact", "id": "<uuid>", "field": "Photo", "content_base64": "<base64>"}. ' +
      'Файл с привязкой через общее хранилище — bpm_upload_file. Параметр id принимает UUID или название записи.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    blurb: 'PUT бинарь в поле сущности',
    category: 'stream',
  },
  {
    name: 'bpm_field_download',
    title: 'Скачать бинарь из поля',
    description:
      'GET бинарных данных из поля сущности ({Collection}({id})/{Field}). return_base64=true возвращает ' +
      'содержимое в structuredContent.content_base64 (в пределах лимита размера); save_path сохраняет файл на ' +
      'хост MCP-сервера (только stdio-режим или внутри BPMSOFT_FILE_ROOT); без них — размер. ' +
      'Пример: {"collection": "Contact", "id": "<uuid>", "field": "Photo", "return_base64": true}. ' +
      'Параметр id принимает UUID или название записи.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'GET бинарь из поля сущности',
    category: 'stream',
  },
  {
    name: 'bpm_field_delete',
    title: 'Очистить бинарное поле',
    description:
      'Подготавливает очистку бинарного поля конкретной записи. Пример: {"collection":"Contact","id":"<uuid>","field":"Photo"}. Выполнение требует confirm=true и confirmation_token из превью, привязанный к записи и полю. Используется для удаления бинарного содержимого; для удаления самой записи используйте bpm_delete_record.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    blurb: 'DELETE бинарь в поле сущности (требует confirm=true)',
    category: 'stream',
  },

  // ---- WORKFLOW (composite scenarios on top of CRUD) ----
  {
    name: 'bpm_register_contact',
    title: 'Зарегистрировать контакт',
    description:
      'Сохранены force, серверная проверка существующего контакта по email или имени, подстановка должности и контрагента. ' +
      'Регистрирует контакт и при необходимости находит или создаёт контрагента после предварительной проверки всех требований. Пример: {"name":"Иванов Иван","account_name":"Example","extra":{"Город":"Москва"},"idempotency_key":"<уникальный ключ>"}. Неоднозначные связи требуют уточнения до записи. Частичный результат сохраняет UUID созданных сущностей и выполненные шаги; account_id позволяет безопасно продолжить с уже созданным контрагентом.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    blurb: 'регистрация контакта (+ привязка к контрагенту по имени)',
    category: 'workflow',
  },
  {
    name: 'bpm_log_activity',
    title: 'Зафиксировать активность',
    description:
      'Сохранены defaults текущего пользователя, календарные сроки, категория и однозначные названия связанных записей. ' +
      'Создаёт активность, заранее проверяя тип, владельца, сроки и связь с записью. Пример: {"title":"Позвонить клиенту","type":"Звонок","owner_name":"Петров","related_collection":"Account","related_id":"<uuid>","idempotency_key":"<ключ>"}. Переданные требования обязательны: неизвестный владелец или отсутствующая связь отменяют создание, а не теряются в предупреждении. Поля и справочники определяются сервером; для комментария в ленту используйте bpm_post_feed.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    blurb: 'создать активность (тип/владелец/связь резолвятся по тексту)',
    category: 'workflow',
  },
  {
    name: 'bpm_set_status',
    title: 'Установить статус записи',
    description:
      'Устанавливает статус по названию, определяя нужное поле и однозначный UUID справочника. Пример: {"collection":"Activity","id":"<uuid>","status":"Завершена"}. При нескольких подходящих полях явно передайте status_field. Ошибки выбора обнаруживаются до записи; expected_etag необязателен и требует поддержки платформой. Прочие изменения выполняются bpm_update_record.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
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
      'Находит записи по имени или заголовку в нескольких коллекциях и возвращает готовые карточки и достоверные количества. Пример: {"query":"Иванов","collections":["Contact","Account"],"top":5}. Показанные записи отделены от counts_by_collection/total_found. При ограничении есть has_more и cursors_by_collection для bpm_get_records. Ошибка одной коллекции отмечается отдельно, не выдаётся за ноль совпадений. Похожие имена остаются кандидатами.',
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
      '"result_parameter_name": "Score"}. Первый вызов возвращает план и confirmation_token; запуск требует тех же параметров, confirm=true и токена. При неизвестном исходе автоматического повтора нет; перед повтором проверьте процесс в BPMSoft.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
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
      'Сначала получите план и confirmation_token. Выполнение требует confirm=true и подходящего одноразового токена; сетевой сбой не разрешает повтор без проверки состояния. ' +
      'Запуск нового процесса с нуля — bpm_run_process.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
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
