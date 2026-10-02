/** Every supplied activity requirement is validated before the create request. */
import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceContainer } from '../tools/init-tool.js';
import type { EntityMetadata, EntityProperty } from '../types/index.js';
import { BpmApiError, UnknownCollectionError, UnknownFieldError } from '../utils/errors.js';
import { getTool } from '../tools/registry.js';
import { notInitialized, resolveRecordId } from '../tools/_guards.js';
import { guidLiteral, isGuid } from '../utils/odata.js';
import {
  operationRecordId,
  recordId,
  writeFailureState,
  validateIdempotencyKey,
  validateRequiredCreateFields,
  MissingRequiredFieldsError,
  writeToolError,
} from '../utils/write-safety.js';

const TITLE = ['Title', 'Subject', 'Caption'];
const OWNER = ['OwnerId', 'Owner', 'ResponsibleId', 'Responsible', 'AuthorId', 'Author'];
const TYPE = ['ActivityCategoryId', 'ActivityCategory', 'TypeId', 'Type', 'ActivityTypeId', 'ActivityType'];
const DUE = ['DueDate', 'StartDate', 'StartedOn', 'DueOn'];
function findField(meta: EntityMetadata, candidates: string[]): EntityProperty | undefined {
  return candidates.map((name) => meta.properties.find((p) => p.name === name)).find(Boolean);
}

class ActivityRelationError extends BpmApiError {
  constructor(
    collection: string,
    public readonly fields: EntityProperty[]
  ) {
    super(
      `Нельзя однозначно установить связь Activity → ${collection}. Укажите related_field; ничего не создано.`,
      400,
      'Activity',
      undefined,
      fields.map((field) => field.name),
      ['Выберите related_field из candidates и повторите вызов.']
    );
  }
  override toToolError() {
    return {
      ...super.toToolError(),
      candidates: this.fields.map((field) => ({
        field: field.name,
        caption: field.caption ?? field.name,
        lookup_collection: field.lookupCollection,
      })),
    };
  }
}

/** Technical relation names distinguish a contact from owner/author contact lookups. */
function relationField(metadata: EntityMetadata, collection: string): EntityProperty {
  const fields = metadata.properties.filter(
    (field) => field.isLookup && field.lookupCollection === collection
  );
  for (const name of [`${collection}Id`, collection]) {
    const canonical = fields.find((field) => field.name === name);
    if (canonical) return canonical;
  }
  const navigation = fields.filter((field) => field.navigationProperty === collection);
  if (navigation.length === 1) return navigation[0];
  if (fields.length === 1) return fields[0];
  throw new ActivityRelationError(collection, fields);
}

const DEFAULT_ACTIVITY_TYPE_ID = 'fbe0acdc-cfc0-df11-b00f-001d60e938c6';
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
      annotations: meta.annotations,
      inputSchema: {
        title: z.string().trim().min(1),
        type: z.string().optional(),
        owner_name: z.string().optional(),
        related_collection: z.string().optional(),
        related_id: z
          .string()
          .optional()
          .describe('UUID связанной записи или её название; сервер разрешает имя.'),
        related_field: z
          .string()
          .optional()
          .describe(
            'Поле связи для нестандартной схемы. Обычно сервер сам выбирает ContactId/AccountId и каноническую навигацию; при неоднозначности возвращает candidates.'
          ),
        due_date: z.string().optional(),
        notes: z.string().optional(),
        idempotency_key: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe('Ключ одной активности. Повтор с теми же данными не создаёт дубль.'),
      },
      outputSchema: {
        activity_id: z.string(),
        used_fields: z.record(z.string(), z.string()),
        warnings: z.array(z.string()),
      },
    },
    async (params): Promise<CallToolResult> => {
      if (!services.initialized) return notInitialized();
      let plannedId: string | undefined;
      try {
        await services.authManager.ensureAuthenticated();
        validateIdempotencyKey(params.idempotency_key);
        const activityMeta = await services.metadataManager.getEntityMetadata('Activity');
        if (typeof params.title !== 'string' || !params.title.trim()) {
          const field = findField(activityMeta, TITLE);
          throw new MissingRequiredFieldsError('Activity', [
            {
              name: field?.name ?? 'Title',
              caption: field?.caption ?? field?.name ?? 'Title',
              type: field?.type ?? 'Edm.String',
            },
          ]);
        }
        if ((params.related_collection === undefined) !== (params.related_id === undefined))
          throw new BpmApiError(
            'Для связи передайте related_collection и related_id вместе.',
            400,
            'Activity'
          );
        if (params.related_field !== undefined && params.related_collection === undefined)
          throw new BpmApiError('related_field требует related_collection и related_id.', 400, 'Activity');
        const data: Record<string, unknown> = {};
        const usedFields: Record<string, string> = {};
        const put = (input: string, value: string, candidates: string[], lookup = false) => {
          const field = findField(activityMeta, candidates);
          if (!field || (lookup && !field.isLookup))
            throw new BpmApiError(
              `Не найдено подходящее поле для ${input}; ничего не создано.`,
              400,
              'Activity'
            );
          data[field.name] = value;
          usedFields[input] = field.name;
        };
        put('title', params.title, TITLE);
        if (params.notes !== undefined) put('notes', params.notes, ['Notes', 'Description']);
        if (params.due_date !== undefined) put('due_date', params.due_date, DUE);
        if (params.type !== undefined) {
          const field = findField(activityMeta, TYPE);
          const category = field?.isLookup ? await pickSameNamedCategory(services, field, params.type) : null;
          put('type', category ?? params.type, TYPE);
        }
        if (params.owner_name !== undefined) put('owner', params.owner_name, OWNER, true);
        if (params.related_collection !== undefined && params.related_id !== undefined) {
          const ref = await services.metadataManager.resolveCollectionReference(params.related_collection);
          if (ref.name === null) throw new UnknownCollectionError(params.related_collection, ref.suggestions);
          const related = await resolveRecordId(services, ref.name, params.related_id);
          let field: EntityProperty;
          if (params.related_field !== undefined) {
            const fieldRef = await services.metadataManager.resolveFieldReference(
              'Activity',
              params.related_field
            );
            if (fieldRef.name === null)
              throw new UnknownFieldError(params.related_field, 'Activity', fieldRef.suggestions);
            const explicit = activityMeta.properties.find((property) => property.name === fieldRef.name);
            if (!explicit?.isLookup || explicit.lookupCollection !== ref.name)
              throw new BpmApiError(
                `Поле ${fieldRef.name} не является связью Activity → ${ref.name}.`,
                400,
                'Activity'
              );
            field = explicit;
          } else field = relationField(activityMeta, ref.name);
          if (field.name in data) {
            const existing = (
              await services.lookupResolver.resolveDataLookups('Activity', { [field.name]: data[field.name] })
            ).data[field.name];
            if (typeof existing !== 'string' || existing.toLowerCase() !== related.id.toLowerCase())
              throw new BpmApiError(
                `Параметры владельца/типа и related_field задают разные значения поля ${field.name}.`,
                400,
                'Activity'
              );
          }
          await services.odataClient.getRecord(ref.name, related.id);
          data[field.name] = related.id;
          usedFields.relation = field.name;
        }
        const resolved = await services.lookupResolver.resolveDataLookups('Activity', data);
        await validateRequiredCreateFields(services, 'Activity', resolved.data);
        plannedId = operationRecordId(services, params.idempotency_key, 'log-activity');
        const created = await services.odataClient.createRecord<Record<string, unknown>>(
          'Activity',
          resolved.data,
          { id: plannedId }
        );
        const activityId = recordId(created);
        const output = { activity_id: activityId, used_fields: usedFields, warnings: [] };
        return {
          content: [{ type: 'text', text: `Активность создана: ${params.title} (${activityId}).` }],
          structuredContent: output,
        };
      } catch (error) {
        const formatted = writeToolError(error, 'Activity');
        const output = {
          ...formatted,
          ...(plannedId ? { activity_id: plannedId, state: writeFailureState(error) } : {}),
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
          isError: true,
        };
      }
    }
  );
}
