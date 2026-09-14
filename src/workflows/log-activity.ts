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
import { notInitialized, resolveRecordId } from '../tools/_guards.js';
import { isMeMacro, meIdFor } from '../utils/me-macro.js';
import { guidLiteral, isGuid } from '../utils/odata.js';

/** Тип, который BPMSoft ставит Activity по умолчанию (ActivityType «Задача»). */
const DEFAULT_ACTIVITY_TYPE_ID = 'fbe0acdc-cfc0-df11-b00f-001d60e938c6';

const TITLE_CANDIDATES = ['Title', 'Subject', 'Caption'];
const OWNER_CANDIDATES = ['Owner', 'OwnerId', 'Author', 'AuthorId', 'Responsible', 'ResponsibleId'];
const TYPE_CANDIDATES = [
  'ActivityCategory',
  'ActivityCategoryId',
  'Type',
  'TypeId',
  'ActivityType',
  'ActivityTypeId',
];
const DUE_DATE_CANDIDATES = ['DueDate', 'StartDate', 'StartedOn', 'DueOn'];

function findFieldName(meta: EntityMetadata, candidates: string[]): EntityProperty | undefined {
  for (const cand of candidates) {
    const prop = meta.properties.find((p) => p.name === cand);
    if (prop) return prop;
  }
  return undefined;
}

/** Системные ссылки на Contact — связью с записью они не являются. */
const SYSTEM_LOOKUPS = new Set(['CreatedById', 'ModifiedById', 'OwnerId', 'AuthorId']);

function findLookupTo(meta: EntityMetadata, targetCollection: string): EntityProperty | undefined {
  const candidates = meta.properties.filter((p) => p.isLookup && p.lookupCollection === targetCollection);
  // ContactId/Contact раньше системных CreatedById/ModifiedById: иначе связь с контактом
  // записывалась в «Кем создан» (проверено на bpm9).
  const entity = targetCollection.replace(/Collection$/, '');
  return (
    candidates.find((p) => p.name === `${entity}Id` || p.name === entity) ??
    candidates.find((p) => !SYSTEM_LOOKUPS.has(p.name))
  );
}

/**
 * В ActivityCategory бывают одноимённые строки: «Звонок» для типа «Звонок» и для
 * типа «Задача». Если все кандидаты названы одинаково, берём тот, чей ActivityTypeId
 * совпадает с типом создаваемой активности (BPMSoft по умолчанию ставит «Задача»).
 * Иначе null — и resolveDataLookups вернёт обычную ошибку неоднозначности.
 */
async function pickSameNamedCategory(
  services: ServiceContainer,
  typeField: EntityProperty,
  value: string
): Promise<string | null> {
  if (!typeField.lookupCollection || isGuid(value)) return null;
  const lookup = await services.lookupResolver.resolve(
    typeField.lookupCollection,
    value,
    typeField.lookupDisplayColumn ?? 'Name',
    { fuzzy: true }
  );
  if (lookup.resolved || lookup.matchCount < 2) return null;
  if (new Set(lookup.candidates.map((c) => c.displayValue)).size !== 1) return null;
  const version = services.config.odata_version;
  const filter = lookup.candidates.map((c) => `Id eq ${guidLiteral(c.id, version)}`).join(' or ');
  try {
    const res = await services.odataClient.getRecords<Record<string, unknown>>(typeField.lookupCollection, {
      $filter: filter,
      $select: 'Id,ActivityTypeId',
    });
    const hits = res.value.filter((r) => r.ActivityTypeId === DEFAULT_ACTIVITY_TYPE_ID);
    return hits.length === 1 ? String(hits[0].Id) : null;
  } catch {
    // Нет колонки ActivityTypeId (другая схема) — остаётся ошибка неоднозначности.
    return null;
  }
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
          .describe(
            'ФИО владельца — будет найден в Contact.Name и подставлен в OwnerId. "я" / "@me" — текущий пользователь.'
          ),
        related_collection: z
          .string()
          .optional()
          .describe('Коллекция связанной записи (Account, Contact, Opportunity, Lead и т.п.).'),
        related_id: z
          .string()
          .optional()
          .describe('UUID связанной записи или её название (ищется в related_collection нечётким поиском).'),
        due_date: z.string().optional().describe('Срок выполнения (ISO-8601).'),
        notes: z.string().optional().describe('Заметки (Notes/Description).'),
      },
      outputSchema: {
        activity_id: z.string(),
        used_fields: z.record(z.string(), z.string()),
        warnings: z.array(z.string()),
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
            data[typeField.name] =
              (await pickSameNamedCategory(services, typeField, params.type)) ?? params.type;
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
          const ownerCollection = ownerField?.lookupCollection ?? 'Contact';
          if (ownerField && ownerField.isLookup && isMeMacro(params.owner_name)) {
            const meId = meIdFor(ownerCollection, await services.currentUser.get());
            if (meId) {
              data[ownerField.name] = meId;
              usedFields.owner = ownerField.name;
            } else {
              warnings.push(
                `Текущий пользователь не связан с записью ${ownerCollection} — поле ${ownerField.name} оставлено пустым.`
              );
            }
          } else if (ownerField && ownerField.isLookup) {
            const ownerLookup = await services.lookupResolver.resolve(
              ownerCollection,
              params.owner_name,
              ownerField.lookupDisplayColumn ?? 'Name',
              { fuzzy: true }
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
            const rel = await resolveRecordId(services, params.related_collection, params.related_id);
            data[relField.name] = rel.id;
            usedFields.relation = relField.name;
            if (rel.matched && rel.matched !== params.related_id) {
              warnings.push(
                `Связанная запись "${params.related_id}" найдена как "${rel.matched}" (${rel.id}).`
              );
            }
          } else {
            warnings.push(
              `В Activity нет lookup-поля, ссылающегося на ${params.related_collection}; связь не установлена.`
            );
          }
        }

        const resolved = await services.lookupResolver.resolveDataLookups('Activity', data);
        for (const n of resolved.notes) {
          warnings.push(`Поле ${n.field}: "${n.input}" разрешено неточно как "${n.matchedValue}"`);
        }
        const created = await services.odataClient.createRecord<Record<string, unknown>>(
          'Activity',
          resolved.data
        );
        const activityId = String(
          (created as { Id?: unknown; id?: unknown }).Id ?? (created as { id?: unknown }).id ?? ''
        );

        return {
          content: [
            {
              type: 'text',
              text: [
                `Активность зафиксирована: ${params.title} (${activityId})`,
                `Использованные поля: ${Object.entries(usedFields)
                  .map(([k, v]) => `${k}=${v}`)
                  .join(', ')}`,
                warnings.length ? `Предупреждения: ${warnings.join('; ')}` : '',
              ]
                .filter(Boolean)
                .join('\n'),
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
