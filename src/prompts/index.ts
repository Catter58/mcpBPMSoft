/**
 * MCP Prompts registration.
 *
 * Each prompt is a pure template — no tool calls inside callbacks.
 * Args are validated via Zod schemas declared in PROMPTS registry.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GetPromptResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceContainer } from '../tools/init-tool.js';
import { PROMPTS } from './registry.js';

function userMessage(text: string): GetPromptResult {
  return {
    messages: [
      {
        role: 'user',
        content: { type: 'text', text },
      },
    ],
  };
}

const GETTING_STARTED_TEXT = [
  'Этот сервер даёт доступ к BPMSoft (low-code CRM/BPM платформа) через OData API.',
  '',
  'Ключевые сущности (коллекции):',
  '  • Contact — контактные лица (ФИО, email, телефон, привязка к Account).',
  '  • Account — контрагенты (юр. лица).',
  '  • Lead — потенциальные сделки/обращения.',
  '  • Opportunity — продажи в работе (воронка, стадии, суммы).',
  '  • Activity — задачи, звонки, встречи (с привязкой к контактам/сделкам).',
  '',
  'Типичные сценарии и инструменты:',
  '  • Поиск: bpm_search_unified (подстрока по нескольким коллекциям) или',
  '    bpm_search_records (criteria-DSL на русском, операторы «содержит»,',
  '    «равно», «за последние N дней» и т.п.).',
  '  • Чтение: bpm_get_records (фильтры/select/expand), bpm_get_record (по UUID),',
  '    bpm_count_records (подсчёт).',
  '  • Запись: bpm_create_record / bpm_update_record / bpm_delete_record.',
  '    Lookup-поля можно передавать текстом — UUID разрешится автоматически.',
  '  • Композитные сценарии: bpm_register_contact (контакт + автосоздание Account),',
  '    bpm_log_activity (задача с авторезолвингом типа/владельца/связи),',
  '    bpm_set_status (статус по русскому имени).',
  '  • Схема: bpm_get_collections, bpm_get_schema, bpm_find_field.',
  '    Поля сопровождаются русскими подписями (caption) из SysSchema —',
  '    можно искать «ИНН», «Город», «Дата создания» и т.п.',
  '  • Массовые операции: bpm_update_by_filter / bpm_delete_by_filter требуют',
  '    параметр expected_count (защита от случайного массового изменения).',
  '',
  'Подсказка: имена полей и значения справочников можно передавать на русском —',
  'сервер сам разрешит их в OData-идентификаторы и UUID.',
].join('\n');

export function registerPrompts(server: McpServer, _services: ServiceContainer): void {
  for (const meta of PROMPTS) {
    if (meta.name === 'getting_started') {
      server.registerPrompt(
        meta.name,
        {
          title: meta.title,
          description: meta.description,
        },
        async () => userMessage(GETTING_STARTED_TEXT)
      );
      continue;
    }

    if (meta.name === 'quick_search') {
      server.registerPrompt(
        meta.name,
        {
          title: meta.title,
          description: meta.description,
          argsSchema: meta.argsSchema!,
        },
        async (args) => {
          const query = (args as { query: string }).query;
          const text = [
            `Найди в BPMSoft: ${query}.`,
            '',
            'Используй bpm_search_unified для сквозного поиска по основным коллекциям',
            '(Contact, Account, Lead, Opportunity). Если найдено что-то релевантное —',
            'вызови bpm_get_record по UUID для получения деталей.',
            '',
            'При необходимости уточни запрос через bpm_search_records с criteria-DSL.',
          ].join('\n');
          return userMessage(text);
        }
      );
      continue;
    }

    if (meta.name === 'create_contact_flow') {
      server.registerPrompt(
        meta.name,
        {
          title: meta.title,
          description: meta.description,
          argsSchema: meta.argsSchema!,
        },
        async (args) => {
          const a = args as { name: string; account?: string; email?: string; phone?: string };
          const lines = [
            `Зарегистрируй контакт: ${a.name}.`,
            '',
            'Используй инструмент bpm_register_contact со следующими параметрами:',
            `  • name: ${a.name}`,
          ];
          if (a.account) lines.push(`  • account: ${a.account} (создать или найти)`);
          if (a.email) lines.push(`  • email: ${a.email}`);
          if (a.phone) lines.push(`  • phone: ${a.phone}`);
          lines.push(
            '',
            'Если account указан — сервер сам найдёт его в Account по имени или создаст',
            'новую запись и привяжет контакт через AccountId. После успеха верни UUID',
            'созданного контакта.'
          );
          return userMessage(lines.join('\n'));
        }
      );
      continue;
    }

    if (meta.name === 'weekly_report') {
      server.registerPrompt(
        meta.name,
        {
          title: meta.title,
          description: meta.description,
          argsSchema: meta.argsSchema!,
        },
        async (args) => {
          const raw = (args as { period_days?: string }).period_days;
          const days = raw && raw.trim().length > 0 ? raw : '7';
          const text = [
            `Подготовь отчёт за последние ${days} дней.`,
            '',
            'Используй bpm_search_records с criteria-DSL и оператором',
            '«за последние N дней» (или «>= сегодня минус N»):',
            `  1. Новые контакты: collection=Contact, criteria=[{field:'Дата создания', op:'за последние N дней', value:${days}}].`,
            `  2. Активные сделки: collection=Opportunity, criteria по полю стадии (исключить «Закрыта»/«Отменена»), при необходимости bpm_get_schema(Opportunity).`,
            `  3. Завершённые задачи: collection=Activity, criteria=[{field:'Status', op:'равно', value:'Завершено'}, {field:'Дата изменения', op:'за последние N дней', value:${days}}].`,
            '',
            'Сведи результат в три кратких блока с количеством и top-5 примерами.',
          ].join('\n');
          return userMessage(text);
        }
      );
      continue;
    }

    if (meta.name === 'cleanup_duplicates_check') {
      server.registerPrompt(
        meta.name,
        {
          title: meta.title,
          description: meta.description,
          argsSchema: meta.argsSchema!,
        },
        async (args) => {
          const a = args as { collection: string; field?: string };
          const field = a.field && a.field.trim().length > 0 ? a.field : 'Name';
          const text = [
            `Найди потенциальные дубликаты в коллекции ${a.collection} по полю ${field}.`,
            '',
            'Шаги:',
            `  1. bpm_count_records(collection='${a.collection}') — общий объём.`,
            `  2. bpm_find_duplicates(collection='${a.collection}', fields=['${field}']) — сервер сам нормализует и группирует кандидатов.`,
            '  3. Покажи группы, исходные значения и UUID. Укажи complete и scanned_count; частичный результат не является полным аудитом.',
            '',
            'ВАЖНО: ничего не удалять автоматически. Перед любым bpm_delete_*',
            'используй превью и confirmation_token для точного набора после подтверждения пользователя.',
          ].join('\n');
          return userMessage(text);
        }
      );
      continue;
    }

    if (meta.name === 'pipeline_analysis') {
      server.registerPrompt(
        meta.name,
        {
          title: meta.title,
          description: meta.description,
          argsSchema: meta.argsSchema!,
        },
        async (args) => {
          const a = args as { stage_field?: string };
          const stage =
            a.stage_field && a.stage_field.trim().length > 0
              ? a.stage_field
              : 'StageId/StatusId — определи через bpm_get_schema(Opportunity)';
          const text = [
            'Проанализируй воронку Opportunity.',
            '',
            `Поле стадии: ${stage}.`,
            '',
            'Шаги:',
            "  1. Если поле стадии неизвестно — вызови bpm_get_schema('Opportunity')",
            '     и найди lookup-поле статуса/стадии.',
            "  2. bpm_aggregate_records(collection='Opportunity', group_by=[<stage_field>],",
            "     metrics=[{field: 'Amount', op: 'sum'}, {field: 'Amount', op: 'avg'}]).",
            '  3. Верни готовые группы с display_dimensions, count и metrics. Не пересчитывай числа вручную.',
            '  4. Укажи complete и scanned_count. Конверсию нельзя вывести из одного текущего снимка без истории переходов.',
          ].join('\n');
          return userMessage(text);
        }
      );
      continue;
    }
  }
}
