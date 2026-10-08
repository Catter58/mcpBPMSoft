/**
 * MCP Tool: bpm_workflow_catalog
 *
 * Возвращает каталог типичных задач, рекомендуемых инструментов, связей сущностей
 * и ограничений, известных MCP-серверу. Это ориентир, а не схема конкретного инстанса.
 *
 * Сценарии и связи статичны; значения лимитов берутся из текущей конфигурации сервера.
 */

import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceContainer } from './init-tool.js';
import { getTool } from './registry.js';

interface WorkflowScenario {
  id: string;
  title: string;
  user_intent: string;
  recommended_tools: string[];
  notes?: string;
}

const SCENARIOS: WorkflowScenario[] = [
  {
    id: 'register-contact',
    title: 'Зарегистрировать нового контакта',
    user_intent:
      'Пользователь говорит «добавь контакт», «создай Иванова из Ромашки», «нужен новый человек в CRM».',
    recommended_tools: ['bpm_register_contact'],
    notes:
      'Один вызов вместо create_record(Account)+create_record(Contact). Account будет найден или создан автоматически. account_created/contact_created: true — создан этим вызовом, false — существующий или не выполнено (см. outcomes), null — факт создания неизвестен; при успешном результате сама запись подтверждена по UUID.',
  },
  {
    id: 'log-activity',
    title: 'Записать активность (звонок/задача/встреча)',
    user_intent:
      '«Поставь задачу перезвонить завтра», «зафиксируй звонок с Ивановым», «запиши встречу на четверг».',
    recommended_tools: ['bpm_log_activity'],
    notes: 'Тип активности и владелец резолвятся по тексту через справочники.',
  },
  {
    id: 'change-status',
    title: 'Сменить статус записи',
    user_intent: '«Закрой эту сделку», «переведи лид в квалифицирован», «отметь задачу выполненной».',
    recommended_tools: ['bpm_set_status'],
    notes: 'Передаётся имя статуса на русском; сервер сам найдёт правильное status-поле и его справочник.',
  },
  {
    id: 'find-anything',
    title: 'Сквозной поиск по подстроке',
    user_intent: '«Найди всё про Иванова», «есть ли контрагент Ромашка», «покажи всё связанное с X».',
    recommended_tools: ['bpm_search_unified'],
    notes:
      'Ищет в Contact/Account/Lead/Opportunity параллельно. Для уточнения — bpm_search_records по конкретной коллекции.',
  },
  {
    id: 'targeted-search',
    title: 'Целевой поиск по критериям',
    user_intent: '«Контакты из Москвы», «активные сделки за последний месяц», «лиды с просроченным звонком».',
    recommended_tools: ['bpm_search_records'],
    notes:
      'Поддерживает русские названия полей и операторов («Город»=Москва, «Дата создания» «за последние 30 дней»). Не нужно писать $filter руками.',
  },
  {
    id: 'browse-data',
    title: 'Посмотреть карточку записи',
    user_intent: '«Покажи карточку Иванова», «что в этой задаче», «детали по сделке».',
    recommended_tools: ['bpm_record_card', 'bpm_get_record'],
    notes:
      'Оба принимают название записи вместо UUID — искать Id отдельно не нужно; при наличии уникального бизнес-ключа можно задать match_by как 1–8 точных полей с AND-семантикой. bpm_record_card — карточка 360° со связанными разделами, файлами и лентой.',
  },
  {
    id: 'mass-update',
    title: 'Массовое обновление по фильтру',
    user_intent: '«Закрой все заявки старше года», «обнови менеджера у этих клиентов», «переведи в архив».',
    recommended_tools: ['bpm_update_by_filter'],
    notes:
      'Без expected_count первый вызов показывает число и названия. Передайте точный expected_count, чтобы получить план; после показа списка и явного подтверждения пользователя повторите с confirm=true и confirmation_token из плана. Если снимок изменился, проверьте возвращённые поля и новый preview/token и запросите подтверждение повторно; автоматически ничего не записывается.',
  },
  {
    id: 'mass-delete',
    title: 'Массовое удаление по фильтру',
    user_intent: 'Запрос на массовое удаление (требует подтверждения пользователя!).',
    recommended_tools: ['bpm_delete_by_filter'],
    notes:
      'Получите план точных записей, покажите список «Название (Id)» и дождитесь явного подтверждения пользователя. Только затем повторите с expected_count, confirm=true и confirmation_token из плана. Stale-конфликт покажет изменившиеся значения и новый план; получите отдельное подтверждение перед повтором.',
  },
  {
    id: 'attach-file',
    title: 'Прикрепить файл к записи',
    user_intent: '«Прикрепи договор», «загрузи фото к контакту», «приложи скан».',
    recommended_tools: ['bpm_upload_file', 'bpm_field_upload'],
    notes:
      'bpm_upload_file — для общего хранилища SysImage с привязкой. bpm_field_upload — прямая запись в произвольное бинарное поле сущности.',
  },
  {
    id: 'analytics',
    title: 'Цифры: суммы, группировки, воронка, динамика',
    user_intent:
      '«Сколько открытых сделок по стадиям», «сумма заказов за квартал», «закрытые обращения за месяц против прошлого».',
    recommended_tools: ['bpm_aggregate', 'bpm_count_records'],
    notes:
      'Считает сервер, выгружать записи не нужно. Открытость/закрытость/успех — операторы «открыт»/«закрыт»/«успешно» по флагам справочника статусов (End, FinalStatus, IsFinal, Finish). Нестандартный ESQ-отчёт — бизнес-процесс через bpm_run_process.',
  },
  {
    id: 'post-to-feed',
    title: 'Оставить комментарий в ленте записи',
    user_intent:
      '«Запиши заметку к этой задаче», «прокомментируй сделку», «оставь сообщение в ленте контакта».',
    recommended_tools: ['bpm_post_feed'],
    notes:
      'Использует OData коллекцию SocialMessage. Сообщение видно всем, кто имеет доступ к записи; не путать с Activity (задачей).',
  },
  {
    id: 'discover-options',
    title: 'Узнать допустимые значения',
    user_intent: '«Какие бывают типы активности», «какие статусы у лида», «варианты для поля Тип».',
    recommended_tools: ['bpm_get_enum_values'],
    notes:
      'Нужен, чтобы показать варианты пользователю. Для записи не обязателен: create/update сами сопоставят текст и при промахе вернут допустимые значения.',
  },
  {
    id: 'order-with-products',
    title: 'Заказ или счёт с продуктами',
    user_intent: '«Оформи заказ Ромашке на 2 ноутбука и 3 мыши», «выставь счёт по заказу».',
    recommended_tools: ['bpm_create_record', 'bpm_batch_create'],
    notes:
      'Создайте Order (номер присвоится сам), затем строки OrderProduct одним bpm_batch_create с OrderId, ProductId (по названию) и Quantity. Цену, название, единицу, суммы строк и итог заказа сервер посчитает сам — OData этого не делает. То же для Invoice/InvoiceProduct.',
  },
  {
    id: 'onboarding',
    title: 'Сориентироваться в незнакомом инстансе',
    user_intent: 'Первый запрос к новому инстансу BPMSoft, нужно понять что там есть.',
    recommended_tools: ['bpm_describe_instance', 'bpm_get_collections'],
    notes:
      'bpm_describe_instance — главный «обзор», далее точечные bpm_get_schema по интересующим коллекциям.',
  },
];

interface EntityRelation {
  from: string;
  to: string;
  via: string;
  meaning: string;
}

const ENTITY_GRAPH: { entities: string[]; relations: EntityRelation[] } = {
  entities: [
    'Contact',
    'Account',
    'Lead',
    'Opportunity',
    'Order',
    'OrderProduct',
    'Product',
    'Contract',
    'Invoice',
    'InvoiceProduct',
    'Activity',
    'Case',
    'Project',
    'Document',
  ],
  relations: [
    { from: 'Contact', to: 'Account', via: 'AccountId', meaning: 'контакт работает в контрагенте' },
    { from: 'Activity', to: 'Contact', via: 'ContactId', meaning: 'активность с контактом' },
    { from: 'Activity', to: 'Account', via: 'AccountId', meaning: 'активность с контрагентом' },
    { from: 'Activity', to: 'Opportunity', via: 'OpportunityId', meaning: 'активность по сделке' },
    {
      from: 'Lead',
      to: 'Account',
      via: 'QualifiedAccountId',
      meaning: 'лид → контрагент после квалификации',
    },
    { from: 'Lead', to: 'Contact', via: 'QualifiedContactId', meaning: 'лид → контакт после квалификации' },
    { from: 'Opportunity', to: 'Account', via: 'AccountId', meaning: 'сделка с контрагентом' },
    { from: 'Opportunity', to: 'Contact', via: 'ContactId', meaning: 'основной контакт сделки' },
    { from: 'Order', to: 'Account', via: 'AccountId', meaning: 'заказ от контрагента' },
    { from: 'Order', to: 'Opportunity', via: 'OpportunityId', meaning: 'заказ из сделки' },
    { from: 'Lead', to: 'Opportunity', via: 'OpportunityId', meaning: 'лид → сделка' },
    {
      from: 'Opportunity',
      to: 'Product',
      via: 'OpportunityProductInterest',
      meaning: 'интерес к продуктам в сделке',
    },
    {
      from: 'OrderProduct',
      to: 'Order',
      via: 'OrderId',
      meaning: 'строка заказа (ProductId, Quantity, Price)',
    },
    {
      from: 'OrderProduct',
      to: 'Product',
      via: 'ProductId',
      meaning: 'продукт из каталога (Price, UnitId, TaxId)',
    },
    { from: 'Contract', to: 'Order', via: 'OrderId', meaning: 'договор по заказу' },
    {
      from: 'Contract',
      to: 'Account',
      via: 'AccountId',
      meaning: 'договор с контрагентом (номер, срок, состояние)',
    },
    { from: 'Invoice', to: 'Order', via: 'OrderId', meaning: 'счёт по заказу' },
    { from: 'Invoice', to: 'Contract', via: 'ContractId', meaning: 'счёт по договору' },
    { from: 'InvoiceProduct', to: 'Invoice', via: 'InvoiceId', meaning: 'строка счёта' },
    { from: 'Case', to: 'Contact', via: 'ContactId', meaning: 'обращение клиента' },
    { from: 'Project', to: 'Opportunity', via: 'OpportunityId', meaning: 'проект по сделке' },
    { from: 'Document', to: 'Contract', via: 'ContractId', meaning: 'документ по договору' },
  ],
};

const INSTANCE_SCOPE_NOTE =
  'Схема и бизнес-правила зависят от инстанса. Проверьте наличие коллекций и полей через bpm_get_collections и bpm_get_schema; для обзора используйте bpm_describe_instance.';

function getLimits(services: ServiceContainer): string[] {
  const limits = [
    'Лимиты строк и размер ответа OData могут зависеть от инстанса; при чтении уточняйте filter, select и используйте cursor.',
    'Для распознанных сервером строк заказа или счёта MCP-инструменты рассчитывают поддерживаемые суммы; проверьте фактическую схему через bpm_get_schema.',
    'Если номер документа в инстансе присваивается автоматически, не передавайте его без просьбы пользователя; проверьте правила конкретной коллекции.',
    'Для нескольких записей используйте bpm_batch_*; проверяйте итоги и ошибки по каждому элементу. Массовые обновления и удаления требуют показа плана и отдельного подтверждения.',
  ];
  const config = services.config;
  if (config && Number.isFinite(config.max_batch_size)) {
    limits.push(
      `Размер одного блока $batch в текущей конфигурации сервера: ${config.max_batch_size} операций.`
    );
  }
  if (config && Number.isFinite(config.max_file_size)) {
    limits.push(`Максимальный размер файла в текущей конфигурации сервера: ${config.max_file_size} байт.`);
  }
  if (config?.odata_version === 3) {
    limits.push(
      'При OData v3 имена EntitySet и lookup-полей могут отличаться от OData v4; используйте схему инстанса.'
    );
  } else if (config?.odata_version === 4) {
    limits.push(
      'При OData v4 имена EntitySet и lookup-полей могут отличаться от OData v3; используйте схему инстанса.'
    );
  }
  return limits;
}

const scenarioShape = z.object({
  id: z.string(),
  title: z.string(),
  user_intent: z.string(),
  recommended_tools: z.array(z.string()),
  notes: z.string().optional(),
});

export function registerWorkflowCatalogTool(server: McpServer, services: ServiceContainer): void {
  const meta = getTool('bpm_workflow_catalog');
  server.registerTool(
    meta.name,
    {
      title: meta.title,
      description: meta.description,
      inputSchema: {
        scenario_id: z
          .string()
          .optional()
          .describe('Если указан — вернуть детали только этого сценария (id из общего каталога).'),
      },
      outputSchema: {
        scenario: scenarioShape.optional(),
        scenarios: z.array(scenarioShape).optional(),
        entity_graph: z
          .object({
            entities: z.array(z.string()),
            relations: z.array(
              z.object({ from: z.string(), to: z.string(), via: z.string(), meaning: z.string() })
            ),
          })
          .optional(),
        scope_note: z.string().optional(),
        limits: z.array(z.string()).optional(),
      },
      annotations: meta.annotations,
    },
    async (params): Promise<CallToolResult> => {
      if (params.scenario_id) {
        const sc = SCENARIOS.find((s) => s.id === params.scenario_id);
        if (!sc) {
          const ids = SCENARIOS.map((s) => s.id).join(', ');
          return {
            content: [
              {
                type: 'text',
                text: `Сценарий "${params.scenario_id}" не найден. Доступные id: ${ids}`,
              },
            ],
            isError: true,
            structuredContent: {
              success: false,
              code: 'not_found',
              error: `Сценарий ${params.scenario_id} не найден`,
              suggestions: SCENARIOS.map((scenario) => scenario.id),
            },
          };
        }
        return {
          content: [{ type: 'text', text: `${renderScenario(sc)}\n\n${INSTANCE_SCOPE_NOTE}` }],
          structuredContent: { scenario: sc, scope_note: INSTANCE_SCOPE_NOTE },
        };
      }

      const limits = getLimits(services);
      const lines: string[] = [
        '# Каталог типичных сценариев',
        '',
        INSTANCE_SCOPE_NOTE,
        '',
        '## Типичные сценарии',
        '',
      ];
      for (const sc of SCENARIOS) {
        lines.push(renderScenario(sc));
        lines.push('');
      }

      lines.push('## Карта основных сущностей');
      lines.push('');
      for (const e of ENTITY_GRAPH.entities) lines.push(`  • ${e}`);
      lines.push('');
      lines.push('### Связи');
      for (const r of ENTITY_GRAPH.relations) {
        lines.push(`  ${r.from} → ${r.to} (${r.via}) — ${r.meaning}`);
      }
      lines.push('');
      lines.push('## Возможности и ограничения текущей конфигурации');
      for (const l of limits) lines.push(`  • ${l}`);

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: {
          scenarios: SCENARIOS,
          entity_graph: ENTITY_GRAPH,
          scope_note: INSTANCE_SCOPE_NOTE,
          limits,
        },
      };
    }
  );
}

function renderScenario(sc: WorkflowScenario): string {
  const lines: string[] = [`### ${sc.title}  (id: ${sc.id})`];
  lines.push(`Когда: ${sc.user_intent}`);
  lines.push(`Tools: ${sc.recommended_tools.join(', ')}`);
  if (sc.notes) lines.push(`Заметки: ${sc.notes}`);
  return lines.join('\n');
}
