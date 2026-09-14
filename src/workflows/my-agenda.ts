/**
 * MCP Tool: bpm_my_agenda
 *
 * «Что у меня на сегодня?» раньше стоило модели три-четыре вызова: узнать себя,
 * отфильтровать по ответственному, по статусу и по датам в правильном поясе.
 * Сервер делает это сам. Незавершённость берётся из справочника статусов
 * (ActivityStatus.Finish, OpportunityStage.End), а не из названий, поэтому
 * переименованные статусы выборку не ломают. Фильтры по связям — через
 * навигацию (Owner/Id): FK-формы на части стендов рвут поток.
 */

import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceContainer } from '../tools/init-tool.js';
import { formatToolError } from '../utils/errors.js';
import { getTool } from '../tools/registry.js';
import { notInitialized, resolveRecordId } from '../tools/_guards.js';
import { guidLiteral } from '../utils/odata.js';
import { getRecordsWithLookupNames, displayKeyFor } from '../utils/display.js';
import { calendarRange, resolveTimeZone, zonedParts, zonedMidnightUtc } from '../utils/datetime.js';
import { isMeMacro } from '../utils/me-macro.js';

const DAY_MS = 86_400_000;
const FETCH_CAP = 500;

export interface AgendaItem {
  id: string;
  title: string;
  due: string | null;
  start: string | null;
  status: string | null;
  category: string | null;
}

/** Делит незавершённые задачи по сроку: просрочено (до «сейчас»), сегодня, дальше. */
export function splitAgenda(
  items: AgendaItem[],
  now: Date,
  todayEnd: Date
): { overdue: AgendaItem[]; today: AgendaItem[]; upcoming: AgendaItem[] } {
  const result = { overdue: [] as AgendaItem[], today: [] as AgendaItem[], upcoming: [] as AgendaItem[] };
  for (const item of items) {
    const due = item.due ? new Date(item.due).getTime() : Number.NaN;
    if (Number.isNaN(due) || due >= todayEnd.getTime()) result.upcoming.push(item);
    else if (due < now.getTime()) result.overdue.push(item);
    else result.today.push(item);
  }
  return result;
}

function dateLiteral(date: Date, odataVersion: 3 | 4): string {
  const iso = date.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return odataVersion === 3 ? `datetime'${iso.replace(/Z$/, '')}'` : iso;
}

function formatLocal(value: string | null, timeZone: string): string {
  if (!value) return 'без срока';
  const p = zonedParts(new Date(value), timeZone);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(p.day)}.${pad(p.month)} ${pad(p.hour)}:${pad(p.minute)}`;
}

const itemShape = z.object({
  id: z.string(),
  title: z.string(),
  due: z.string().nullable(),
  start: z.string().nullable(),
  status: z.string().nullable(),
  category: z.string().nullable(),
});

export function registerMyAgendaTool(server: McpServer, services: ServiceContainer): void {
  const meta = getTool('bpm_my_agenda');
  server.registerTool(
    meta.name,
    {
      title: meta.title,
      description: meta.description,
      inputSchema: {
        days: z
          .number()
          .int()
          .min(0)
          .max(60)
          .optional()
          .describe('На сколько дней вперёд показывать задачи (по умолчанию 7)'),
        owner: z
          .string()
          .optional()
          .describe('Чья повестка: ФИО сотрудника или "я" (по умолчанию — текущий пользователь)'),
        stale_days: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Показать незакрытые сделки без изменений дольше N дней'),
        limit: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe('Сколько записей максимум в каждом разделе (по умолчанию 20)'),
      },
      outputSchema: {
        owner: z.object({ id: z.string(), name: z.string() }),
        time_zone: z.string(),
        now: z.string(),
        counts: z.object({ overdue: z.number().int(), today: z.number().int(), upcoming: z.number().int() }),
        overdue: z.array(itemShape),
        today: z.array(itemShape),
        upcoming: z.array(itemShape),
        stale_opportunities: z
          .array(
            z.object({
              id: z.string(),
              title: z.string(),
              stage: z.string().nullable(),
              modified_on: z.string().nullable(),
            })
          )
          .optional(),
        warnings: z.array(z.string()),
      },
      annotations: meta.annotations,
    },
    async (params): Promise<CallToolResult> => {
      if (!services.initialized) return notInitialized();
      try {
        await services.authManager.ensureAuthenticated();
        const warnings: string[] = [];
        const version = services.config.odata_version;
        const limit = params.limit ?? 20;
        const days = params.days ?? 7;

        const user = await services.currentUser.get();
        const timeZone = resolveTimeZone(user.timeZoneId || undefined);

        let ownerId: string;
        let ownerName: string;
        if (!params.owner || isMeMacro(params.owner)) {
          if (!user.contactId) {
            throw new Error('У текущего пользователя нет связанного контакта — передайте owner (ФИО).');
          }
          ownerId = user.contactId;
          ownerName = user.contactName ?? user.userName;
        } else {
          const resolved = await resolveRecordId(services, 'Contact', params.owner);
          ownerId = resolved.id;
          ownerName = resolved.matched ?? params.owner;
        }

        const now = new Date();
        const todayEnd = calendarRange('today', timeZone, now).to;
        const local = zonedParts(now, timeZone);
        const horizon = zonedMidnightUtc(local.year, local.month, local.day + days + 1, timeZone);
        const deps = {
          metadataManager: services.metadataManager,
          odataClient: services.odataClient,
          odataVersion: version,
        };

        const { records } = await getRecordsWithLookupNames(
          deps,
          'Activity',
          {
            $filter:
              `Owner/Id eq ${guidLiteral(ownerId, version)} and Status/Finish eq false` +
              ` and DueDate lt ${dateLiteral(horizon, version)}`,
            $select: 'Id,Title,StartDate,DueDate,StatusId,ActivityCategoryId',
            $orderby: 'DueDate asc',
            $top: FETCH_CAP,
          },
          { resolveLookups: true }
        );
        if (records.length === FETCH_CAP) {
          warnings.push(`Задач больше ${FETCH_CAP} — показаны первые по сроку.`);
        }

        const items: AgendaItem[] = records.map((r) => ({
          id: String(r.Id),
          title: String(r.Title ?? ''),
          due: (r.DueDate as string | null) ?? null,
          start: (r.StartDate as string | null) ?? null,
          status: (r[displayKeyFor('StatusId')] as string | undefined) ?? null,
          category: (r[displayKeyFor('ActivityCategoryId')] as string | undefined) ?? null,
        }));
        const split = splitAgenda(items, now, todayEnd);

        let stale:
          | Array<{ id: string; title: string; stage: string | null; modified_on: string | null }>
          | undefined;
        if (params.stale_days) {
          try {
            const since = new Date(now.getTime() - params.stale_days * DAY_MS);
            const { records: opps } = await getRecordsWithLookupNames(
              deps,
              'Opportunity',
              {
                $filter:
                  `Owner/Id eq ${guidLiteral(ownerId, version)} and Stage/End eq false` +
                  ` and ModifiedOn lt ${dateLiteral(since, version)}`,
                $select: 'Id,Title,StageId,ModifiedOn',
                $orderby: 'ModifiedOn asc',
                $top: limit,
              },
              { resolveLookups: true }
            );
            stale = opps.map((o) => ({
              id: String(o.Id),
              title: String(o.Title ?? ''),
              stage: (o[displayKeyFor('StageId')] as string | undefined) ?? null,
              modified_on: (o.ModifiedOn as string | null) ?? null,
            }));
          } catch (error) {
            warnings.push(`Сделки не получены: ${error instanceof Error ? error.message : String(error)}`);
          }
        }

        const section = (title: string, list: AgendaItem[]) => [
          `${title}: ${list.length}`,
          ...list.slice(0, limit).map((i) => {
            const tags = [i.status, i.category].filter(Boolean).join(' · ');
            return `  - ${formatLocal(i.due, timeZone)} · ${i.title}${tags ? ` [${tags}]` : ''} (${i.id})`;
          }),
          ...(list.length > limit ? [`  … ещё ${list.length - limit}`] : []),
        ];
        const lines = [
          `Повестка: ${ownerName} · пояс ${timeZone} · сейчас ${formatLocal(now.toISOString(), timeZone)}`,
          '',
          ...section('Просрочено', split.overdue),
          ...section('Сегодня', split.today),
          ...section(`Ближайшие ${days} дн.`, split.upcoming),
          ...(stale
            ? [
                '',
                `Сделки без движения дольше ${params.stale_days} дн.: ${stale.length}`,
                ...stale.map(
                  (o) =>
                    `  - ${o.title}${o.stage ? ` [${o.stage}]` : ''}, изменена ${formatLocal(o.modified_on, timeZone)} (${o.id})`
                ),
              ]
            : []),
          ...(warnings.length ? ['', ...warnings.map((w) => `Внимание: ${w}`)] : []),
        ];

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: {
            owner: { id: ownerId, name: ownerName },
            time_zone: timeZone,
            now: now.toISOString(),
            counts: {
              overdue: split.overdue.length,
              today: split.today.length,
              upcoming: split.upcoming.length,
            },
            overdue: split.overdue.slice(0, limit),
            today: split.today.slice(0, limit),
            upcoming: split.upcoming.slice(0, limit),
            ...(stale ? { stale_opportunities: stale } : {}),
            warnings,
          },
        };
      } catch (error) {
        const toolError = formatToolError(error, 'Activity');
        return { content: [{ type: 'text', text: JSON.stringify(toolError, null, 2) }], isError: true };
      }
    }
  );
}
