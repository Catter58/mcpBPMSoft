/**
 * MCP Tool: bpm_workflow_catalog
 *
 * Возвращает каталог типичных пользовательских сценариев работы с BPMSoft +
 * карту основных сущностей и их связей. Для LLM это «карта местности» —
 * быстрая ориентация в начале сессии без перебора bpm_get_collections.
 *
 * Контент статичный (не требует сетевых вызовов), берётся из проектной
 * документации BPMSoft 1.8.
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
    notes:
      'Передаётся имя статуса на русском; сервер сам найдёт правильное status-поле и его справочник.',
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
    recommended_tools: ['bpm_lookup_value', 'bpm_get_record'],
    notes:
      'Сначала bpm_lookup_value по имени → UUID, затем bpm_get_record по UUID. Или ресурс bpmsoft://entity/{collection}/{id}.',
  },
  {
    id: 'mass-update',
    title: 'Массовое обновление по фильтру',
    user_intent: '«Закрой все заявки старше года», «обнови менеджера у этих клиентов», «переведи в архив».',
    recommended_tools: ['bpm_search_records', 'bpm_update_by_filter'],
    notes:
      'Сначала проверьте число затрагиваемых записей через bpm_search_records, потом передайте expected_count в bpm_update_by_filter — операция отменится при несовпадении.',
  },
  {
    id: 'mass-delete',
    title: 'Массовое удаление по фильтру',
    user_intent: 'Запрос на массовое удаление (требует подтверждения пользователя!).',
    recommended_tools: ['bpm_search_records', 'bpm_delete_by_filter'],
    notes:
      'ВАЖНО: всегда показывайте пользователю предполагаемые записи и явное подтверждение, прежде чем вызывать bpm_delete_by_filter. expected_count обязателен.',
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
    id: 'esq-via-process',
    title: 'Сложные запросы (агрегации, JOIN-ы) через ESQ',
    user_intent:
      '«Сделай SQL-подобный отчёт с группировкой», «нужны цифры по воронке с агрегацией», «JOIN нескольких сущностей с условиями».',
    recommended_tools: ['bpm_run_process'],
    notes:
      'BPMSoft не предоставляет HTTP-API для прямого выполнения EntitySchemaQuery. Стандартный паттерн: разработчик создаёт бизнес-процесс с Script Task внутри, который выполняет ESQ-запрос и возвращает JSON в выходной параметр. Затем этот процесс вызывается через bpm_run_process с указанием result_parameter_name. Пример доступен в документации «Запустить бизнес-процесс через веб-сервис».',
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
    recommended_tools: ['bpm_get_schema', 'bpm_get_enum_values'],
    notes:
      'bpm_get_schema даёт перечень полей; bpm_get_enum_values возвращает все значения справочника к указанному lookup-полю.',
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
  entities: ['Contact', 'Account', 'Lead', 'Opportunity', 'Activity', 'Order', 'Case'],
  relations: [
    { from: 'Contact', to: 'Account', via: 'AccountId', meaning: 'контакт работает в контрагенте' },
    { from: 'Activity', to: 'Contact', via: 'ContactId', meaning: 'активность с контактом' },
    { from: 'Activity', to: 'Account', via: 'AccountId', meaning: 'активность с контрагентом' },
    { from: 'Activity', to: 'Opportunity', via: 'OpportunityId', meaning: 'активность по сделке' },
    { from: 'Lead', to: 'Account', via: 'QualifiedAccountId', meaning: 'лид → контрагент после квалификации' },
    { from: 'Lead', to: 'Contact', via: 'QualifiedContactId', meaning: 'лид → контакт после квалификации' },
    { from: 'Opportunity', to: 'Account', via: 'AccountId', meaning: 'сделка с контрагентом' },
    { from: 'Opportunity', to: 'Contact', via: 'ContactId', meaning: 'основной контакт сделки' },
    { from: 'Order', to: 'Account', via: 'AccountId', meaning: 'заказ от контрагента' },
    { from: 'Order', to: 'Opportunity', via: 'OpportunityId', meaning: 'заказ из сделки' },
  ],
};

const LIMITS = [
  'Максимум строк в одном OData-ответе: 20 000.',
  'Максимум подзапросов в $batch: 100.',
  'OData v3 не поддерживает $batch (используйте OData v4).',
  'Размер файла на загрузку: 10 МБ (настраивается через BPMSOFT_MAX_FILE_SIZE).',
  'OData v3 EntitySet с суффиксом Collection (ContactCollection); v4 — без (Contact).',
  'Lookup-поля: v4 — суффикс Id (CityId), v3 — без суффикса (City).',
];

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

      const lines: string[] = [
        '# Каталог сценариев работы с BPMSoft',
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
