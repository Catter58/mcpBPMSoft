/**
 * Single source of truth for MCP tool metadata.
 *
 * Each tool registered via server.registerTool consults this list for its
 * title/description/annotations. The `bpm_init` welcome message and the
 * startup log read from the same list — no more drift between counts.
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
      'Инициализирует подключение к BPMSoft (URL, логин, пароль, версия OData, платформа) и проверяет учётные данные. Должен быть вызван первым, если сервер запущен без переменных окружения BPMSOFT_URL/USERNAME/PASSWORD. После успешного вызова все остальные инструменты становятся работоспособными.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'инициализация подключения (URL, логин/пароль, OData v3/4, платформа)',
    category: 'init',
  },

  // ---- READ ----
  {
    name: 'bpm_get_records',
    title: 'Список записей коллекции',
    description:
      'Возвращает записи указанной OData-коллекции с фильтрацией ($filter), выборкой полей ($select), сортировкой ($orderby), $expand и $top/$skip. По умолчанию автопагинация выключена и применяется лимит max_records (избегаем переполнения контекста LLM). Установите auto_paginate=true и/или увеличьте max_records если нужен полный набор.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'получить записи коллекции (фильтр/select/expand/order/top/skip, безопасный лимит)',
    category: 'read',
  },
  {
    name: 'bpm_get_record',
    title: 'Запись по ID',
    description: 'Возвращает одну запись коллекции по UUID с опциональными $select и $expand.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'получить запись по UUID',
    category: 'read',
  },
  {
    name: 'bpm_count_records',
    title: 'Количество записей',
    description: 'Возвращает число записей коллекции через /$count, опционально с $filter.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'подсчёт записей с опциональным фильтром',
    category: 'read',
  },
  {
    name: 'bpm_search_records',
    title: 'Поиск с критериями (рус.)',
    description:
      'Альтернатива bpm_get_records с человекочитаемыми критериями. Принимает массив criteria вида [{field, op, value}], где field может быть на русском (caption), op — на русском («содержит», «равно», «за последние 7 дней», «между») или OData (eq/contains/...). Сервер сам соберёт $filter. Полезен, когда LLM не хочет писать OData синтаксис вручную.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'поиск по criteria-DSL (RU/EN, с auto-резолвингом полей)',
    category: 'read',
  },

  // ---- WRITE ----
  {
    name: 'bpm_create_record',
    title: 'Создать запись',
    description:
      'Создаёт запись в коллекции (POST). Lookup-поля можно передавать человекочитаемыми текстовыми значениями — сервер автоматически разрешит UUID. Возвращает созданную запись.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    blurb: 'создать запись (с авторезолвингом lookup-полей)',
    category: 'write',
  },
  {
    name: 'bpm_update_record',
    title: 'Обновить запись',
    description:
      'Обновляет поля записи по UUID (PATCH). Lookup-поля с текстовыми значениями разрешаются автоматически. Идемпотентно при одинаковых данных.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'обновить запись по UUID',
    category: 'write',
  },
  {
    name: 'bpm_delete_record',
    title: 'Удалить запись',
    description: 'Удаляет запись из коллекции по UUID (DELETE). Действие необратимо.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    blurb: 'удалить запись по UUID',
    category: 'write',
  },
  {
    name: 'bpm_update_by_filter',
    title: 'Обновить по фильтру',
    description:
      'Находит записи по $filter и обновляет каждую через PATCH. Требует параметр expected_count: если найдено иное число записей — операция отменяется (защита от случайного массового обновления).',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    blurb: 'массовое обновление по фильтру (с защитным expected_count)',
    category: 'write',
  },
  {
    name: 'bpm_delete_by_filter',
    title: 'Удалить по фильтру',
    description:
      'Находит записи по $filter и удаляет каждую через DELETE. Требует параметр expected_count: при несовпадении операция отменяется. Действие необратимо.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    blurb: 'массовое удаление по фильтру (с защитным expected_count)',
    category: 'write',
  },

  // ---- SCHEMA / LOOKUP ----
  {
    name: 'bpm_get_collections',
    title: 'Список коллекций',
    description:
      'Возвращает доступные EntitySet (коллекции) BPMSoft из $metadata. Поддерживает фильтр-подстроку по имени.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'список доступных коллекций',
    category: 'schema',
  },
  {
    name: 'bpm_get_schema',
    title: 'Схема коллекции',
    description:
      'Возвращает схему коллекции: поля, типы, обязательность, lookup-связи. По возможности включает локализованные подписи (рус. названия) полей из SysSchema/SysEntitySchemaColumn.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'схема коллекции (поля, типы, lookup, рус. подписи)',
    category: 'schema',
  },
  {
    name: 'bpm_lookup_value',
    title: 'Найти UUID по значению',
    description:
      'Резолвит UUID записи справочника по человекочитаемому значению (точное совпадение eq). При fuzzy=true и пустом результате повторяет поиск через contains() и возвращает кандидатов.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'найти UUID справочного значения',
    category: 'schema',
  },
  {
    name: 'bpm_get_enum_values',
    title: 'Значения справочника поля',
    description:
      'Возвращает значения справочника, к которому привязано lookup-поле указанной коллекции. Например, для Activity.ActivityCategory вернёт список всех категорий активностей с UUID и названиями. Полезно перед bpm_create_record/bpm_update_record для перечисления вариантов или поиска UUID по точному имени.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'значения справочника для lookup-поля',
    category: 'schema',
  },
  {
    name: 'bpm_workflow_catalog',
    title: 'Каталог типичных сценариев',
    description:
      'Возвращает каталог типичных пользовательских сценариев работы с BPMSoft и какие tool-ы для них вызывать. Карта основных сущностей и их связей. Ограничения BPMSoft 1.8. Используйте в начале сессии, когда LLM-агент не знает с чего начать.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    blurb: 'каталог сценариев и карта сущностей',
    category: 'schema',
  },
  {
    name: 'bpm_find_field',
    title: 'Поиск поля по подписи',
    description:
      'Находит поля по фрагменту русского/английского названия среди уже загруженных схем коллекций. Полезно когда пользователь оперирует «ИНН», «Город» и т.п.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'поиск поля по подписи (RU/EN)',
    category: 'schema',
  },
  {
    name: 'bpm_describe_instance',
    title: 'Краткая сводка по инстансу BPMSoft',
    description:
      'Возвращает обзор инстанса: число коллекций, главные бизнес-сущности (Contact, Account, Activity, Lead, Opportunity, Order, Case — те, что реально присутствуют), счётчики записей в них, число пользовательских (Usr*) коллекций и кастомных полей в основных сущностях. Кеширует результат на 5 минут. Полезен в самом начале диалога с новым инстансом.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'обзор инстанса (главные сущности, кастомные коллекции/поля)',
    category: 'schema',
  },

  // ---- BATCH (v4 only) ----
  {
    name: 'bpm_batch_create',
    title: 'Пакетное создание',
    description:
      'Создаёт несколько записей в одном $batch (только OData v4). Lookup-поля автоматически резолвятся. Поддерживает continue_on_error для пропуска ошибочных записей.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    blurb: 'пакетное создание (OData v4)',
    category: 'batch',
  },
  {
    name: 'bpm_batch_update',
    title: 'Пакетное обновление',
    description:
      'Обновляет несколько записей в одном $batch (только OData v4). Lookup-поля резолвятся автоматически. Поддерживает continue_on_error.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'пакетное обновление (OData v4)',
    category: 'batch',
  },
  {
    name: 'bpm_batch_delete',
    title: 'Пакетное удаление',
    description:
      'Удаляет несколько записей по UUID в одном $batch (только OData v4). Поддерживает continue_on_error. Действие необратимо.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    blurb: 'пакетное удаление (OData v4)',
    category: 'batch',
  },

  // ---- STREAM ----
  {
    name: 'bpm_upload_file',
    title: 'Загрузить файл в SysImage',
    description:
      'Загружает локальный файл в SysImage: создаёт запись метаданных и кладёт бинарные данные. Опционально привязывает к указанной записи по полю-ссылке.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    blurb: 'загрузить файл (через SysImage)',
    category: 'stream',
  },
  {
    name: 'bpm_download_file',
    title: 'Скачать файл из SysImage',
    description: 'Скачивает бинарные данные из SysImage по UUID и сохраняет в файл (если указан save_path).',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'скачать файл из SysImage',
    category: 'stream',
  },
  {
    name: 'bpm_field_upload',
    title: 'Загрузить бинарь в поле',
    description:
      'PUT бинарных данных напрямую в поле сущности по схеме {Collection}({id})/{FieldName}. Используйте для произвольных бинарных полей (не только SysImage).',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'PUT бинарь в поле сущности',
    category: 'stream',
  },
  {
    name: 'bpm_field_download',
    title: 'Скачать бинарь из поля',
    description:
      'GET бинарных данных напрямую из поля сущности по схеме {Collection}({id})/{FieldName}. Сохраняет в save_path или возвращает размер.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'GET бинарь из поля сущности',
    category: 'stream',
  },
  {
    name: 'bpm_field_delete',
    title: 'Очистить бинарное поле',
    description: 'DELETE бинарных данных в поле сущности.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    blurb: 'DELETE бинарь в поле сущности',
    category: 'stream',
  },

  // ---- WORKFLOW (composite scenarios on top of CRUD) ----
  {
    name: 'bpm_register_contact',
    title: 'Зарегистрировать контакт',
    description:
      'Зарегистрировать контакт. Опционально создаёт/находит контрагента (Account) по имени и привязывает к нему контакт. Один вызов вместо create_record(Account)+create_record(Contact)+update_record. Все имена полей могут быть переданы на русском (caption) или латинице.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    blurb: 'регистрация контакта (+ привязка к контрагенту по имени)',
    category: 'workflow',
  },
  {
    name: 'bpm_log_activity',
    title: 'Зафиксировать активность',
    description:
      'Зафиксировать активность (задача, звонок, встреча) с привязкой к записи. Тип активности и владелец резолвятся по тексту через справочники. Поддерживает связь с Contact/Account/Opportunity.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    blurb: 'создать активность (тип/владелец/связь резолвятся по тексту)',
    category: 'workflow',
  },
  {
    name: 'bpm_set_status',
    title: 'Установить статус записи',
    description:
      'Установить статус записи по человекочитаемому имени. Сервер сам найдёт поле-статус в коллекции (StatusId/StageId) и разрешит UUID статуса в его справочнике.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'установить статус по имени (Status/Stage авто-детект)',
    category: 'workflow',
  },
  {
    name: 'bpm_search_unified',
    title: 'Сквозной поиск',
    description:
      'Сквозной поиск по подстроке Name в основных коллекциях (Contact, Account, Lead, Opportunity). Возвращает плоский список совпадений с указанием коллекции и UUID. Подходит для запросов вида «найди всё про Иванова».',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    blurb: 'сквозной поиск по Name в основных коллекциях',
    category: 'workflow',
  },

  // ---- PROCESS / FEED (BPMSoft outside OData) ----
  {
    name: 'bpm_run_process',
    title: 'Запустить бизнес-процесс',
    description:
      'Вызывает ProcessEngineService.svc/{ProcessName}/Execute. Передаёт входные параметры через query-string. Опционально возвращает результат указанного выходного параметра. Используется для запуска кастомных БП, обёртывающих сложную логику (например, ESQ-запросы с агрегацией, массовые операции, бизнес-логика).',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    blurb: 'запустить бизнес-процесс по имени',
    category: 'process',
  },
  {
    name: 'bpm_exec_process_element',
    title: 'Запустить элемент процесса',
    description:
      'Вызывает ProcessEngineService.svc/ExecProcElByUId с UID элемента. Используется для возобновления приостановленных элементов (например, пользовательских задач) уже выполняющегося процесса.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    blurb: 'запустить элемент уже выполняющегося процесса',
    category: 'process',
  },
  {
    name: 'bpm_post_feed',
    title: 'Опубликовать сообщение в ленту записи',
    description:
      'Создаёт запись в коллекции SocialMessage для целевой записи (entity+id). Лента — основной канал комментариев BPMSoft. Параметры: collection (имя сущности), id (UUID записи), message (текст). Опционально: parent_id для ответа на сообщение.',
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
