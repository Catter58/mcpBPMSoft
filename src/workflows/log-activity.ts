/**
 * MCP Tool: bpm_log_activity
 *
 * Create an Activity record with optional auto-resolved owner, type and
 * relation lookups. The exact field names are discovered from metadata so
 * the tool works across BPMSoft instances with different schema captions.
 */

import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceContainer } from '../tools/init-tool.js';
import type { EntityMetadata, EntityProperty } from '../types/index.js';
import { formatToolError } from '../utils/errors.js';
import { getTool } from '../tools/registry.js';
import { notInitialized } from '../tools/_guards.js';

const TITLE_CANDIDATES = ['Title', 'Subject', 'Caption'];
const OWNER_CANDIDATES = ['Owner', 'OwnerId', 'Author', 'AuthorId', 'Responsible', 'ResponsibleId'];
const TYPE_CANDIDATES = ['ActivityCategory', 'ActivityCategoryId', 'Type', 'TypeId', 'ActivityType', 'ActivityTypeId'];
const DUE_DATE_CANDIDATES = ['DueDate', 'StartDate', 'StartedOn', 'DueOn'];

function findFieldName(meta: EntityMetadata, candidates: string[]): EntityProperty | undefined {
  for (const cand of candidates) {
    const prop = meta.properties.find((p) => p.name === cand);
    if (prop) return prop;
  }
  return undefined;
}

function findLookupTo(meta: EntityMetadata, targetCollection: string): EntityProperty | undefined {
  return meta.properties.find((p) => p.isLookup && p.lookupCollection === targetCollection);
}

export function registerLogActivityTool(server: McpServer, services: ServiceContainer): void {
  const meta = getTool('bpm_log_activity');
  server.registerTool(
    meta.name,
    {
      title: meta.title,
      description: meta.description,
      inputSchema: {
        title: z.string().describe('Заголовок активности (обязательное поле)'),
        type: z
          .string()
          .optional()
          .describe('Тип активности (например, "Звонок", "Email", "Встреча"). Резолвится через справочник.'),
        owner_name: z
          .string()
          .optional()
          .describe('ФИО владельца — будет найден в Contact.Name и подставлен в OwnerId.'),
        related_collection: z
          .string()
          .optional()
          .describe('Коллекция связанной записи (Account, Contact, Opportunity, Lead и т.п.).'),
        related_id: z.string().optional().describe('UUID связанной записи.'),
        due_date: z.string().optional().describe('Срок выполнения (ISO-8601).'),
        notes: z.string().optional().describe('Заметки (Notes/Description).'),
      },
      annotations: meta.annotations,
    },
    async (params): Promise<CallToolResult> => {
      if (!services.initialized) return notInitialized();
      try {
        await services.authManager.ensureAuthenticated();
        const warnings: string[] = [];

        const activityMeta = await services.metadataManager.getEntityMetadata('Activity');

        const titleField = findFieldName(activityMeta, TITLE_CANDIDATES);
        if (!titleField) {
          throw new Error('В метаданных Activity не найдено поле заголовка (Title/Subject/Caption).');
        }

        const data: Record<string, unknown> = {};
        data[titleField.name] = params.title;
        const usedFields: Record<string, string> = { title: titleField.name };

        if (params.notes !== undefined) {
          const notesField = activityMeta.properties.find(
            (p) => p.name === 'Notes' || p.name === 'Description'
          );
          if (notesField) {
            data[notesField.name] = params.notes;
            usedFields.notes = notesField.name;
          } else {
            warnings.push('Не найдено поле для заметок (Notes/Description) — параметр notes проигнорирован.');
          }
        }

        if (params.due_date !== undefined) {
          const dueField = findFieldName(activityMeta, DUE_DATE_CANDIDATES);
          if (dueField) {
            data[dueField.name] = params.due_date;
            usedFields.due_date = dueField.name;
          } else {
            warnings.push('Не найдено поле срока выполнения — параметр due_date проигнорирован.');
          }
        }

        if (params.type !== undefined) {
          const typeField = findFieldName(activityMeta, TYPE_CANDIDATES);
          if (typeField && typeField.isLookup) {
            data[typeField.name] = params.type;
            usedFields.type = typeField.name;
          } else if (typeField) {
            data[typeField.name] = params.type;
            usedFields.type = typeField.name;
          } else {
            warnings.push('Не найдено поле типа активности — параметр type проигнорирован.');
          }
        }

        if (params.owner_name !== undefined) {
          const ownerField = findFieldName(activityMeta, OWNER_CANDIDATES);
          if (ownerField && ownerField.isLookup) {
            const ownerLookup = await services.lookupResolver.resolve(
              ownerField.lookupCollection ?? 'Contact',
              params.owner_name,
              ownerField.lookupDisplayColumn ?? 'Name'
            );
            if (ownerLookup.resolved && ownerLookup.id) {
              data[ownerField.name] = ownerLookup.id;
              usedFields.owner = ownerField.name;
            } else {
              warnings.push(
                `Не удалось разрешить owner_name "${params.owner_name}" (matchCount=${ownerLookup.matchCount}) — поле ${ownerField.name} оставлено пустым.`
              );
            }
          } else {
            warnings.push('Не найдено lookup-поле владельца — параметр owner_name проигнорирован.');
          }
        }

        if (params.related_collection && params.related_id) {
          const relField = findLookupTo(activityMeta, params.related_collection);
          if (relField) {
            data[relField.name] = params.related_id;
            usedFields.relation = relField.name;
          } else {
            warnings.push(
              `В Activity нет lookup-поля, ссылающегося на ${params.related_collection}; связь не установлена.`
            );
          }
        }

        const resolvedData = await services.lookupResolver.resolveDataLookups('Activity', data);
        const created = await services.odataClient.createRecord<Record<string, unknown>>('Activity', resolvedData);
        const activityId = String(
          (created as { Id?: unknown; id?: unknown }).Id ?? (created as { id?: unknown }).id ?? ''
        );

        return {
          content: [
            {
              type: 'text',
              text: [
                `Активность зафиксирована: ${params.title} (${activityId})`,
                `Использованные поля: ${Object.entries(usedFields).map(([k, v]) => `${k}=${v}`).join(', ')}`,
                warnings.length ? `Предупреждения: ${warnings.join('; ')}` : '',
              ].filter(Boolean).join('\n'),
            },
          ],
          structuredContent: {
            activity_id: activityId,
            used_fields: usedFields,
            warnings,
          },
        };
      } catch (error) {
        const toolError = formatToolError(error, 'Activity');
        return {
          content: [{ type: 'text', text: JSON.stringify(toolError, null, 2) }],
          isError: true,
        };
      }
    }
  );
}
