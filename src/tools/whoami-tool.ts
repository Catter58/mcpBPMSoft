/**
 * MCP Tool: bpm_whoami — кто выполняет вызов и какое сейчас время.
 *
 * Закрывает два слепых пятна модели одновременно. Во-первых, «поставь мне
 * задачу» невозможно выполнить, не зная, кто такой «я»: нужен Contact текущего
 * пользователя, потому что именно им заполняются Owner/Author. Во-вторых,
 * «на сегодня» требует реальной даты в поясе пользователя — у модели своей
 * даты нет, а UTC-полночь не совпадает с местной.
 */

import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceContainer } from './init-tool.js';
import { formatToolError } from '../utils/errors.js';
import { getTool } from './registry.js';
import { notInitialized } from './_guards.js';
import { describeNow, resolveTimeZone } from '../utils/datetime.js';

export function registerWhoamiTool(server: McpServer, services: ServiceContainer): void {
  const meta = getTool('bpm_whoami');
  server.registerTool(
    meta.name,
    {
      title: meta.title,
      description: meta.description,
      inputSchema: {
        timezone: z
          .string()
          .optional()
          .describe(
            'Часовой пояс IANA для расчёта локального времени (например Europe/Moscow). ' +
              'По умолчанию — BPMSOFT_TIMEZONE или пояс сервера.'
          ),
      },
      outputSchema: {
        user: z.object({
          user_id: z.string().describe('Id записи SysAdminUnit'),
          user_name: z.string().describe('Логин'),
          contact_id: z.string().optional().describe('Contact пользователя — им заполняются Owner/Author'),
          contact_name: z.string().optional(),
          contact_email: z.string().optional(),
          culture: z.string().optional(),
          unit_type: z.number().int().optional(),
        }),
        now: z.object({
          utc: z.string().describe('Текущий момент в UTC (в этом виде хранит BPMSoft)'),
          local: z.string().describe('То же время в поясе пользователя'),
          date: z.string().describe('Сегодняшняя календарная дата в поясе пользователя'),
          weekday: z.string(),
          timezone: z.string(),
          offset: z.string(),
        }),
      },
      annotations: meta.annotations,
    },
    async (params): Promise<CallToolResult> => {
      if (!services.initialized) return notInitialized();
      try {
        await services.authManager.ensureAuthenticated();

        const user = await services.currentUser.get();
        const timeZone = resolveTimeZone(params.timezone ?? user.timeZoneId);
        const now = describeNow(timeZone);

        const lines = [
          `Пользователь: ${user.userName} (SysAdminUnit ${user.userId})`,
          user.contactId
            ? `Контакт: ${user.contactName ?? '(без имени)'} — ${user.contactId}`
            : 'Контакт не привязан к учётной записи: подставить «мне» в Owner/Author не получится.',
          user.contactEmail ? `Email: ${user.contactEmail}` : '',
          `Сейчас: ${now.local} (${now.weekday}), пояс ${now.timezone} ${now.offset}`,
          `В UTC: ${now.utc} — именно так хранит время BPMSoft.`,
          user.contactId ? `Для «моих» записей используйте OwnerId/AuthorId = ${user.contactId}.` : '',
        ].filter(Boolean);

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: {
            user: {
              user_id: user.userId,
              user_name: user.userName,
              ...(user.contactId ? { contact_id: user.contactId } : {}),
              ...(user.contactName ? { contact_name: user.contactName } : {}),
              ...(user.contactEmail ? { contact_email: user.contactEmail } : {}),
              ...(user.culture ? { culture: user.culture } : {}),
              ...(user.unitType !== undefined ? { unit_type: user.unitType } : {}),
            },
            now: {
              utc: now.utc,
              local: now.local,
              date: now.date,
              weekday: now.weekday,
              timezone: now.timezone,
              offset: now.offset,
            },
          },
        };
      } catch (error) {
        const toolError = formatToolError(error, 'SysAdminUnit');
        return {
          content: [{ type: 'text', text: JSON.stringify(toolError, null, 2) }],
          isError: true,
        };
      }
    }
  );
}
