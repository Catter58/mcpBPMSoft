/** Every supplied activity requirement is validated before the create request. */
import * as z from 'zod';
import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceContainer } from '../tools/init-tool.js';
import type { EntityMetadata, EntityProperty } from '../types/index.js';
import { BpmApiError, UnknownCollectionError, UnknownFieldError } from '../utils/errors.js';
import { getTool } from '../tools/registry.js';
import { notInitialized, resolveRecordId } from '../tools/_guards.js';
import { prepareActivityData } from './activity-preparation.js';
import { assertPreparedCreate, validateResolvedCreateData } from './create-preparation.js';
import {
  operationRecordIdWithScope,
  recordId,
  writeFailureState,
  validateIdempotencyKey,
  writeToolError,
} from '../utils/write-safety.js';

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

function normalizedActivityArgs(
  data: Record<string, unknown>,
  params: Record<string, unknown>,
  idempotencyKey: string,
  ownerId?: string,
  related?: { collection: string; id: string; field?: string }
): Record<string, unknown> {
  const result: Record<string, unknown> = { idempotency_key: idempotencyKey };
  if (params.idempotency_scope === 'user') result.idempotency_scope = 'user';
  const mappings: Array<[string, string[]]> = [
    ['title', ['Title', 'Subject', 'Caption']],
    ['start_date', ['StartDate', 'StartedOn']],
    ['due_date', ['DueDate', 'DueOn']],
    ['end_date', ['EndDate']],
    ['activity_type', ['TypeId', 'ActivityTypeId']],
    ['category', ['ActivityCategoryId']],
    ['status', ['StatusId']],
    ['notes', ['Notes', 'Description']],
  ];
  for (const [input, fieldNames] of mappings) {
    const fieldName = fieldNames.find((candidate) => data[candidate] !== undefined);
    if (fieldName) result[input] = data[fieldName];
  }
  if (params.duration_minutes !== undefined) result.duration_minutes = params.duration_minutes;
  if (ownerId) result.owner_name = ownerId;
  else if (data.OwnerId !== undefined) result.owner_name = data.OwnerId;
  if (related) {
    result.related_collection = related.collection;
    result.related_id = related.id;
    if (related.field) result.related_field = related.field;
  } else {
    for (const key of ['related_collection', 'related_id', 'related_field']) {
      if (params[key] !== undefined) result[key] = params[key];
    }
  }
  return result;
}

const OWNER_FIELDS = ['OwnerId', 'Owner', 'ResponsibleId', 'Responsible'];

export function registerLogActivityTool(server: McpServer, services: ServiceContainer): void {
  const meta = getTool('bpm_log_activity');
  server.registerTool(
    meta.name,
    {
      title: meta.title,
      description: meta.description,
      annotations: meta.annotations,
      inputSchema: {
        dry_run: z
          .boolean()
          .optional()
          .describe('Проверить и показать нормализованный Activity payload без создания записи.'),
        title: z.string().optional(),
        type: z.string().optional(),
        category: z.string().optional(),
        activity_type: z.string().optional(),
        status: z.string().optional(),
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
        start_date: z.string().optional(),
        end_date: z.string().optional(),
        duration_minutes: z.number().int().positive().optional(),
        notes: z.string().optional(),
        idempotency_key: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe('Ключ одной активности. Повтор с теми же данными не создаёт дубль.'),
        idempotency_scope: z
          .enum(['session', 'user'])
          .optional()
          .describe(
            'user сохраняет UUID по tenant, адресу инстанса и подтверждённому пользователю BPMSoft; требует idempotency_key.'
          ),
      },
      outputSchema: {
        collection: z.literal('Activity').optional(),
        activity_id: z.string().optional(),
        planned_id: z.string().optional(),
        dry_run: z.boolean().optional(),
        ready: z.boolean().optional(),
        blockers: z.array(z.object({ code: z.string(), message: z.string() }).passthrough()).optional(),
        normalized_args: z.record(z.string(), z.unknown()).optional(),
        source_timezone: z
          .object({ time_zone: z.string(), source: z.enum(['profile', 'environment']) })
          .optional(),
        used_fields: z.record(z.string(), z.string()).optional(),
        warnings: z.array(z.string()),
      },
    },
    async (params): Promise<CallToolResult> => {
      if (!services.initialized) return notInitialized();
      let plannedId: string | undefined;
      let normalizedArgs: Record<string, unknown> = { ...params };
      let sourceTimeZone: { time_zone: string; source: 'profile' | 'environment' } | undefined;
      let warnings: string[] = [];
      let availabilityChecked = false;
      let usedFields: Record<string, string> = {};
      try {
        await services.authManager.ensureAuthenticated();
        validateIdempotencyKey(params.idempotency_key);
        if (params.idempotency_scope === 'user' && params.idempotency_key === undefined)
          throw new BpmApiError('idempotency_scope=user требует idempotency_key.', 400, 'Activity');
        const context = services.lookupResolver.createResolutionContext();
        const effectiveIdempotencyKey = params.idempotency_key ?? randomUUID();
        plannedId = await operationRecordIdWithScope(
          services,
          effectiveIdempotencyKey,
          'log-activity',
          params.idempotency_scope ?? 'session',
          context
        );
        const { dry_run: _dryRun, ...rawArgs } = params;
        normalizedArgs = { ...rawArgs, idempotency_key: effectiveIdempotencyKey };
        const activityMeta = await services.metadataManager.getEntityMetadata('Activity');
        if ((params.related_collection === undefined) !== (params.related_id === undefined))
          throw new BpmApiError(
            'Для связи передайте related_collection и related_id вместе.',
            400,
            'Activity'
          );
        if (params.related_field !== undefined && params.related_collection === undefined)
          throw new BpmApiError('related_field требует related_collection и related_id.', 400, 'Activity');
        if (!params.title?.trim()) {
          const missing = await validateResolvedCreateData(services, 'Activity', {}, [], [], [], {
            enrichLineItems: false,
          });
          if (
            !missing.blockers.some((blocker) =>
              blocker.missing_fields?.some((item) => ['Title', 'Subject', 'Caption'].includes(item.name))
            )
          ) {
            const titleField = activityMeta.properties.find((property) =>
              ['Title', 'Subject', 'Caption'].includes(property.name)
            );
            missing.blockers.push({
              code: 'missing_required_fields',
              message: 'Укажите название активности.',
              missing_fields: [
                {
                  name: titleField?.name ?? 'Title',
                  caption: titleField?.caption ?? titleField?.name ?? 'Title',
                  type: titleField?.type ?? 'Edm.String',
                },
              ],
            });
          }
          if (params.dry_run) {
            const output = {
              collection: 'Activity',
              dry_run: true,
              ready: false,
              blockers: missing.blockers,
              normalized_args: normalizedArgs,
              planned_id: plannedId,
              warnings: [],
            };
            return {
              content: [{ type: 'text', text: 'Activity payload содержит блокеры; запись не создавалась.' }],
              structuredContent: output,
              isError: true,
            };
          }
          assertPreparedCreate(missing, 'Activity');
        }
        const relatedTarget: { collection: string; id: string; field: EntityProperty } | undefined =
          params.related_collection !== undefined && params.related_id !== undefined
            ? await (async () => {
                const ref = await services.metadataManager.resolveCollectionReference(
                  params.related_collection!
                );
                if (ref.name === null)
                  throw new UnknownCollectionError(params.related_collection!, ref.suggestions);
                const related = await resolveRecordId(services, ref.name, params.related_id!);
                let field: EntityProperty;
                if (params.related_field !== undefined) {
                  const fieldRef = await services.metadataManager.resolveFieldReference(
                    'Activity',
                    params.related_field
                  );
                  if (fieldRef.name === null)
                    throw new UnknownFieldError(params.related_field!, 'Activity', fieldRef.suggestions);
                  const explicit = activityMeta.properties.find(
                    (property) => property.name === fieldRef.name
                  );
                  if (!explicit?.isLookup || explicit.lookupCollection !== ref.name)
                    throw new BpmApiError(
                      `Поле ${fieldRef.name} не является связью Activity → ${ref.name}.`,
                      400,
                      'Activity'
                    );
                  field = explicit;
                } else field = relationField(activityMeta, ref.name);
                await services.odataClient.getRecord(ref.name, related.id);
                return { collection: ref.name, id: related.id, field };
              })()
            : undefined;
        let effectiveOwnerName = params.owner_name;
        if (relatedTarget && OWNER_FIELDS.includes(relatedTarget.field.name)) {
          if (effectiveOwnerName !== undefined) {
            const ownerResolution = await services.lookupResolver.resolveDataLookups(
              'Activity',
              { [relatedTarget.field.name]: effectiveOwnerName },
              context
            );
            const ownerId = ownerResolution.data[relatedTarget.field.name];
            if (typeof ownerId !== 'string' || ownerId.toLowerCase() !== relatedTarget.id.toLowerCase())
              throw new BpmApiError(
                'Параметры владельца и related_field задают разные значения поля владельца.',
                400,
                'Activity'
              );
          } else effectiveOwnerName = relatedTarget.id;
        }
        const intent = { ...params, owner_name: effectiveOwnerName };
        if (relatedTarget) {
          const semantic = {
            TypeId: { argument: 'activity_type', value: params.activity_type },
            Type: { argument: 'activity_type', value: params.activity_type },
            ActivityTypeId: { argument: 'activity_type', value: params.activity_type },
            ActivityType: { argument: 'activity_type', value: params.activity_type },
            ActivityCategoryId: { argument: 'category', value: params.category ?? params.type },
            ActivityCategory: { argument: 'category', value: params.category ?? params.type },
            StatusId: { argument: 'status', value: params.status },
            Status: { argument: 'status', value: params.status },
          }[relatedTarget.field.name];
          if (semantic) {
            if (semantic.value !== undefined) {
              const resolved = await services.lookupResolver.resolveDataLookups(
                'Activity',
                { [relatedTarget.field.name]: semantic.value },
                context
              );
              const explicitId = resolved.data[relatedTarget.field.name];
              if (
                typeof explicitId !== 'string' ||
                explicitId.toLowerCase() !== relatedTarget.id.toLowerCase()
              )
                throw new BpmApiError(
                  `Параметр ${semantic.argument} и related_field задают разные значения поля ${relatedTarget.field.name}.`,
                  400,
                  'Activity'
                );
            }
            Object.assign(intent, { [semantic.argument]: relatedTarget.id });
          }
        }
        if (params.start_date === undefined && params.end_date === undefined && params.due_date === undefined)
          intent.start_date = 'today';
        const prepared = await prepareActivityData(services, intent, context);
        const data = prepared.data;
        usedFields = prepared.usedFields;
        normalizedArgs = normalizedActivityArgs(data, params, effectiveIdempotencyKey, prepared.ownerId);
        warnings = [...prepared.warnings];
        availabilityChecked = prepared.availabilityChecked === true;
        if (prepared.timeZone)
          sourceTimeZone = { time_zone: prepared.timeZone.timeZone, source: prepared.timeZone.source };
        if (relatedTarget) {
          if (relatedTarget.field.name in data) {
            const existing = (
              await services.lookupResolver.resolveDataLookups(
                'Activity',
                { [relatedTarget.field.name]: data[relatedTarget.field.name] },
                context
              )
            ).data[relatedTarget.field.name];
            if (typeof existing !== 'string' || existing.toLowerCase() !== relatedTarget.id.toLowerCase())
              throw new BpmApiError(
                `Параметры владельца/типа и related_field задают разные значения поля ${relatedTarget.field.name}.`,
                400,
                'Activity'
              );
          }
          data[relatedTarget.field.name] = relatedTarget.id;
          usedFields.relation = relatedTarget.field.name;
          normalizedArgs = normalizedActivityArgs(data, params, effectiveIdempotencyKey, prepared.ownerId, {
            collection: relatedTarget.collection,
            id: relatedTarget.id,
            field: relatedTarget.field.name,
          });
        }
        const validation = await validateResolvedCreateData(services, 'Activity', data, [], [], [], {
          enrichLineItems: false,
        });
        if (params.dry_run) {
          const ready = validation.blockers.length === 0;
          const responseWarnings = [
            ...warnings,
            ...(availabilityChecked
              ? ['Свободное время проверено по текущему снимку; параллельная запись не блокируется.']
              : []),
          ];
          return {
            content: [
              {
                type: 'text',
                text: ready
                  ? 'Activity payload готов; запись не создавалась.'
                  : 'Activity payload содержит блокеры; запись не создавалась.',
              },
            ],
            structuredContent: {
              collection: 'Activity',
              dry_run: true,
              ready,
              blockers: validation.blockers,
              normalized_args: normalizedArgs,
              planned_id: plannedId,
              ...(sourceTimeZone ? { source_timezone: sourceTimeZone } : {}),
              used_fields: usedFields,
              warnings: responseWarnings,
            },
            isError: !ready,
          };
        }
        assertPreparedCreate(validation, 'Activity');
        const created = await services.odataClient.createRecord<Record<string, unknown>>('Activity', data, {
          id: plannedId,
        });
        const activityId = recordId(created);
        const output = {
          activity_id: activityId,
          used_fields: usedFields,
          normalized_args: normalizedArgs,
          planned_id: plannedId,
          ...(sourceTimeZone ? { source_timezone: sourceTimeZone } : {}),
          warnings: [
            ...warnings,
            ...(availabilityChecked
              ? ['Свободное время проверено по текущему снимку; параллельная запись не блокируется.']
              : []),
          ],
        };
        return {
          content: [
            {
              type: 'text',
              text: `Активность создана${params.title ? `: ${params.title}` : ''} (${activityId}).`,
            },
          ],
          structuredContent: output,
        };
      } catch (error) {
        const formatted = writeToolError(error, 'Activity');
        const output = {
          ...formatted,
          ...(params.dry_run
            ? {
                dry_run: true,
                ready: false,
                blockers: (error as { blockers?: unknown[] }).blockers ?? [
                  { code: formatted.code, message: formatted.error },
                ],
              }
            : {}),
          normalized_args: normalizedArgs,
          ...(plannedId ? { planned_id: plannedId } : {}),
          ...(sourceTimeZone ? { source_timezone: sourceTimeZone } : {}),
          warnings: [
            ...warnings,
            ...(availabilityChecked
              ? ['Свободное время проверено по текущему снимку; параллельная запись не блокируется.']
              : []),
          ],
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
