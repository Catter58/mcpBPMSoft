/**
 * MCP Tool: bpm_workflow_catalog
 *
 * Возвращает каталог типичных пользовательских сценариев работы с BPMSoft +
 * карту основных сущностей и их связей. Для LLM это «карта местности» —
 * быстрая ориентация в начале сессии без перебора bpm_get_collections.
 *
 * Контент статичный (не требует сетевых вызовов), берётся из проектной
 * документации BPMSoft 1.8 и сверен с коробочной конфигурацией тестового стенда.
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
      'Один вызов вместо create_record(Account)+create_record(Contact). Account будет найден или создан автоматически.',
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
      'Оба принимают название записи вместо UUID — искать Id отдельно не нужно. bpm_record_card — карточка 360° со связанными разделами, файлами и лентой.',
  },
  {
    id: 'mass-update',
    title: 'Массовое обновление по фильтру',
    user_intent: '«Закрой все заявки старше года», «обнови менеджера у этих клиентов», «переведи в архив».',
    recommended_tools: ['bpm_update_by_filter'],
    notes:
      'Первый вызов без expected_count сам показывает число и названия найденных записей; повторите с этим expected_count — при несовпадении операция отменится.',
  },
  {
    id: 'mass-delete',
    title: 'Массовое удаление по фильтру',
    user_intent: 'Запрос на массовое удаление (требует подтверждения пользователя!).',
    recommended_tools: ['bpm_delete_by_filter'],
    notes:
      'Первый вызов возвращает список «Название (Id)» — покажите его пользователю; после согласия повторите с expected_count и confirm=true.',
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

const LIMITS = [
  'Максимум строк в одном OData-ответе: 20 000.',
  'Запись через OData не запускает расчёты страницы: суммы строк заказа/счёта и итог заказа сервер MCP считает сам, при прямой записи они остались бы нулевыми.',
  'Номер заказа (Number) присваивается автоматически — не передавайте его без просьбы пользователя.',
  'Несколько записей — одним вызовом bpm_batch_*: сервер сам шлёт $batch (до 100 подзапросов в пакете) или по одному, если $batch не работает (в т.ч. OData v3). Параллельные вызовы bpm_create_record не нужны.',
  'Размер файла на загрузку: 10 МБ (настраивается через BPMSOFT_MAX_FILE_SIZE).',
  'OData v3 EntitySet с суффиксом Collection (ContactCollection); v4 — без (Contact).',
  'Lookup-поля: v4 — суффикс Id (CityId), v3 — без суффикса (City).',
];

const scenarioShape = z.object({
  id: z.string(),
  title: z.string(),
  user_intent: z.string(),
  recommended_tools: z.array(z.string()),
  notes: z.string().optional(),
});

export function registerWorkflowCatalogTool(server: McpServer, _services: ServiceContainer): void {
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
          };
        }
        return {
          content: [{ type: 'text', text: renderScenario(sc) }],
          structuredContent: { scenario: sc },
        };
      }

      const lines: string[] = ['# Каталог сценариев работы с BPMSoft', '', '## Типичные сценарии', ''];
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
      lines.push('## Ограничения BPMSoft 1.8');
      for (const l of LIMITS) lines.push(`  • ${l}`);

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: {
          scenarios: SCENARIOS,
          entity_graph: ENTITY_GRAPH,
          limits: LIMITS,
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
