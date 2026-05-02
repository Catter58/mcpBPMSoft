/**
 * Single source of truth for MCP prompt metadata.
 *
 * Prompts are templated user-facing scenarios that LLM clients can
 * surface as predefined commands. Each entry here defines the public
 * contract (name/title/description/argsSchema) — the actual rendering
 * lives in src/prompts/index.ts.
 */

import * as z from 'zod';

export interface PromptDescriptor {
  name: string;
  /** Short title shown in MCP clients */
  title: string;
  /** Long description used by LLM agents to decide when to use this prompt */
  description: string;
  /**
   * Zod shape for prompt arguments. Each value must be a Zod schema
   * (typically z.string() / z.string().optional()). Passed verbatim to
   * server.registerPrompt({ argsSchema }).
   */
  argsSchema?: Record<string, z.ZodType<string | undefined>>;
  /** Short blurb for listings */
  blurb: string;
}

export const PROMPTS: PromptDescriptor[] = [
  {
    name: 'getting_started',
    title: 'Старт работы с BPMSoft',
    description:
      'Обзор сервера BPMSoft: ключевые сущности, типичные сценарии и инструменты. Используй этот prompt в начале сессии, чтобы быстро понять, что доступно.',
    blurb: 'обзор сервера BPMSoft и список ключевых сценариев',
  },
  {
    name: 'quick_search',
    title: 'Быстрый поиск',
    description:
      'Сквозной поиск по подстроке в основных коллекциях (Contact, Account, Lead, Opportunity). Подсказывает использовать bpm_search_unified, а затем bpm_get_record для деталей.',
    argsSchema: {
      query: z.string().describe('Что искать: ФИО, название контрагента, тема и т.п.'),
    },
    blurb: 'быстрый сквозной поиск по основным коллекциям',
  },
  {
    name: 'create_contact_flow',
    title: 'Создать контакт',
    description:
      'Сценарий регистрации нового контакта (опционально с привязкой к контрагенту). Подсказывает использовать bpm_register_contact с указанными параметрами.',
    argsSchema: {
      name: z.string().describe('ФИО контакта'),
      account: z.string().optional().describe('Название контрагента (опционально)'),
      email: z.string().optional().describe('Email (опционально)'),
      phone: z.string().optional().describe('Телефон (опционально)'),
    },
    blurb: 'зарегистрировать контакт через bpm_register_contact',
  },
  {
    name: 'weekly_report',
    title: 'Отчёт за период',
    description:
      'Подготовка сводки за последние N дней: новые контакты, активные сделки, завершённые задачи. Использует criteria-DSL и операторы относительных дат.',
    argsSchema: {
      period_days: z
        .string()
        .optional()
        .describe('Период в днях (по умолчанию 7)'),
    },
    blurb: 'еженедельный отчёт (контакты + сделки + задачи)',
  },
  {
    name: 'cleanup_duplicates_check',
    title: 'Поиск дубликатов',
    description:
      'Поиск потенциальных дубликатов в коллекции по указанному полю. Только READ-операции — никаких удалений без подтверждения пользователя.',
    argsSchema: {
      collection: z.string().describe('Коллекция для проверки (например: Contact, Account)'),
      field: z.string().optional().describe('Поле для группировки (по умолчанию Name)'),
    },
    blurb: 'найти потенциальные дубликаты (только чтение)',
  },
  {
    name: 'pipeline_analysis',
    title: 'Анализ воронки',
    description:
      'Анализ воронки Opportunity: распределение по стадиям, средняя сумма, конверсии. При необходимости запрашивает схему через bpm_get_schema.',
    argsSchema: {
      stage_field: z
        .string()
        .optional()
        .describe('Поле стадии/статуса (если неизвестно — bpm_get_schema(Opportunity))'),
    },
    blurb: 'анализ воронки Opportunity (стадии, суммы, конверсия)',
  },
];

export function getPrompt(name: string): PromptDescriptor {
  const p = PROMPTS.find((x) => x.name === name);
  if (!p) throw new Error(`Prompt not registered in registry: ${name}`);
  return p;
}
