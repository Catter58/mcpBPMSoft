/** Write tools validate intent before changes and bind bulk confirmation to a snapshot. */
import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceContainer } from './init-tool.js';
import { BpmApiError, UnknownCollectionError } from '../utils/errors.js';
import { buildValueOrigins } from '../utils/write-safety.js';
import { getTool } from './registry.js';
import {
  notInitialized,
  lookupNotesStructured,
  lookupNotesText,
  resolveRecordTarget,
  compileCriteria,
  combineFilters,
} from './_guards.js';
import { coercedText } from '../utils/coerce.js';
import { compactRecord } from '../utils/compact.js';
import { getDisplayColumn } from '../utils/display.js';
import {
  enrichLineItem,
  lineNotesText,
  lineParentIds,
  lineConfig,
  recalcParentTotals,
} from '../workflows/line-items.js';
import {
  confirmParam,
  confirmationTokenParam,
  confirmationResponse,
  createConfirmationPlan,
  consumeConfirmationPlan,
  previewIdList,
} from '../utils/confirm.js';
import {
  criterionSchema,
  recordShape,
  resolvedLookupNoteShape,
  lineItemsNotesShape,
  matchBySchema,
  matchedByShape,
  valueOriginShape,
} from './_schemas.js';
import type { Criterion } from '../utils/filter-compiler.js';
import { isGuid } from '../utils/odata.js';
import { createCreateResolutionContext, prepareCreateIntent } from '../workflows/create-preparation.js';
import {
  prepareUpdateIntent,
  updateOperationSchema,
  type UpdateOperation,
} from '../workflows/update-preparation.js';
import { reservePreparedActivity, releasePreparedActivity } from '../workflows/activity-preparation.js';
import {
  executeSequentialWrites,
  creationRecordIdWithScope,
  validateIdempotencyKey,
  writeToolError,
  previewRecordSummary,
  concurrencyProtection,
  previewWriteFields,
  previewWriteChanges,
  writeChangesText,
  buildClarifications,
  recordId,
  recordEtag,
  selectExactRecords,
  writeFailureState,
} from '../utils/write-safety.js';

const planShape = {
  requires_confirmation: z.boolean().optional(),
  code: z.string().optional(),
  confirmation_token: z.string().optional(),
  records: z.array(z.object({ id: z.string(), display_value: z.string() })).optional(),
  concurrency_protection: z.enum(['etag', 'snapshot_only']).optional(),
  data_fields: z.array(z.object({ field: z.string(), caption: z.string(), value: z.unknown() })).optional(),
  conflict: z
    .object({
      changed: z.array(
        z.object({
          index: z.number().int(),
          id: z.string(),
          fields: z.array(
            z.object({ field: z.string(), before: z.unknown().optional(), current: z.unknown().optional() })
          ),
        })
      ),
    })
    .optional(),
};
const outcomeShape = z.object({
  id: z.string(),
  state: z.enum(['succeeded', 'failed', 'not_executed', 'outcome_unknown']),
  error: z.string().optional(),
});
const verificationArgsShape = z.object({
  collection: z.string(),
  id: z.string(),
  verify: z.object({
    operation: z.enum(['create', 'update', 'delete']),
    expected: z.record(z.string(), z.unknown()).optional(),
  }),
});
const keyParam = z
  .string()
  .min(1)
  .max(200)
  .optional()
  .describe(
    'Ключ одного намерения создать запись. Повтор с тем же ключом и данными использует тот же UUID и не создаёт дубль.'
  );
const etagParam = z
  .string()
  .optional()
  .describe('Версия записи из @odata.etag; обновление/удаление отклоняется, если версия изменилась.');

async function collectionName(services: ServiceContainer, input: string): Promise<string> {
  const ref = await services.metadataManager.resolveCollectionReference(input);
  if (ref.name === null) throw new UnknownCollectionError(input, ref.suggestions);
  return ref.name;
}
async function safeRecordSummary(
  services: ServiceContainer,
  collection: string,
  record: Record<string, unknown>,
  heading: string
): Promise<string[]> {
  try {
    return await recordSummary(services, collection, record, heading);
  } catch {
    return [`${heading} (${String(record.Id ?? record.id ?? '')})`, 'Подписи полей недоступны.'];
  }
}
function snapshotLineParents(collection: string, records: Record<string, unknown>[]): string[] {
  const config = lineConfig(collection);
  if (!config?.parent) return [];
  return [
    ...new Set(
      records.flatMap((record) => {
        const value = record[config.fk];
        return typeof value === 'string' && isGuid(value) && value !== '00000000-0000-0000-0000-000000000000'
          ? [value]
          : [];
      })
    ),
  ];
}
function errorResult(
  error: unknown,
  collection: string,
  extra: Record<string, unknown> = {}
): CallToolResult {
  const formatted = writeToolError(error, collection);
  return {
    content: [{ type: 'text', text: JSON.stringify({ ...formatted, ...extra }, null, 2) }],
    structuredContent: { ...formatted, ...extra },
    isError: true,
  };
}

export function registerWriteTools(server: McpServer, services: ServiceContainer): void {
  {
    const meta = getTool('bpm_create_record');
    server.registerTool(
      meta.name,
      {
        title: meta.title,
        description: meta.description,
        annotations: meta.annotations,
        inputSchema: {
          collection: z.string(),
          data: recordShape,
          strict_required: z
            .boolean()
            .optional()
            .describe(
              'Совместимый параметр. Известные обязательные поля Designer проверяются всегда; nullable OData не означает обязательность ввода.'
            ),
          idempotency_key: keyParam,
          idempotency_scope: z
            .enum(['session', 'user'])
            .optional()
            .describe(
              'Область стабильного ключа: session по умолчанию или user для повторов между сессиями.'
            ),
          dry_run: z.boolean().optional().describe('Подготовить и проверить данные без создания записи.'),
        },
        outputSchema: {
          collection: z.string(),
          record: recordShape.optional(),
          created: z.boolean().nullable().optional(),
          dry_run: z.boolean().optional(),
          ready: z.boolean().optional(),
          normalized_args: z.record(z.string(), z.unknown()).optional(),
          normalized_args_status: z.enum(['complete', 'incomplete']).optional(),
          blockers: z.array(z.record(z.string(), z.unknown())).optional(),
          clarifications: z.array(z.record(z.string(), z.unknown())).optional(),
          changes: z.array(z.record(z.string(), z.unknown())).optional(),
          changes_basis: z.enum(['observed_response', 'requested']).optional(),
          presentation_warnings: z.array(z.string()).optional(),
          verification_args: verificationArgsShape.optional(),
          missing_fields: z
            .array(z.object({ name: z.string(), caption: z.string(), type: z.string() }))
            .optional(),
          no_changes: z.boolean().optional(),
          source_timezone: z
            .object({ time_zone: z.string(), source: z.enum(['profile', 'environment']) })
            .optional(),
          activity_warnings: z.array(z.string()).optional(),
          activity_used_fields: z.record(z.string(), z.string()).optional(),
          resolved_lookups: z.array(resolvedLookupNoteShape).optional(),
          value_origins: z.array(valueOriginShape).optional(),
          line_items_notes: lineItemsNotesShape,
        },
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        let plannedId: string | undefined;
        let mutationCompleted = false;
        let normalizedArgs: Record<string, unknown> | undefined;
        let preparedForOutput: Awaited<ReturnType<typeof prepareCreateIntent>> | undefined;
        let activityReservation:
          | {
              context: NonNullable<ReturnType<typeof services.lookupResolver.createResolutionContext>>;
              prepared: NonNullable<Awaited<ReturnType<typeof prepareCreateIntent>>['activity']>;
            }
          | undefined;
        try {
          await services.authManager.ensureAuthenticated();
          validateIdempotencyKey(params.idempotency_key);
          const collection = await collectionName(services, params.collection);
          const resolutionContext = createCreateResolutionContext(services);
          const prepared = await prepareCreateIntent(services, collection, params.data, resolutionContext);
          preparedForOutput = prepared;
          const { data, line } = prepared;
          normalizedArgs = {
            collection,
            data,
            ...(params.idempotency_key ? { idempotency_key: params.idempotency_key } : {}),
            ...(params.idempotency_scope ? { idempotency_scope: params.idempotency_scope } : {}),
          };
          plannedId = await creationRecordIdWithScope(
            services,
            data,
            params.idempotency_key,
            `${collection}:create`,
            params.idempotency_scope ?? 'session',
            resolutionContext
          );
          normalizedArgs.data = { ...data, Id: plannedId };
          const activityWarnings = prepared.activity
            ? [
                ...prepared.activity.warnings,
                ...(prepared.activity.availabilityChecked
                  ? [
                      'Занятость проверена по снимку; интервал не блокируется атомарно и может измениться до сохранения.',
                    ]
                  : []),
              ]
            : undefined;
          const preparedChanges = await previewWriteChanges(services, collection, undefined, data);
          if (params.dry_run) {
            return {
              content: [
                {
                  type: 'text',
                  text: prepared.blockers.length
                    ? `Подготовка не пройдена: ${prepared.blockers.map((blocker) => blocker.message).join(' ')}\nНормализованные аргументы возвращены для исправления.`
                    : 'Подготовка пройдена. Запись не создана.',
                },
              ],
              structuredContent: {
                collection,
                dry_run: true,
                ready: prepared.blockers.length === 0,
                normalized_args: normalizedArgs,
                normalized_args_status: prepared.blockers.length ? 'incomplete' : 'complete',
                blockers: prepared.blockers,
                clarifications: buildClarifications(prepared.blockers),
                changes: preparedChanges.changes,
                changes_basis: 'requested',
                ...(preparedChanges.warnings.length
                  ? { presentation_warnings: preparedChanges.warnings }
                  : {}),
                ...(prepared.source_timezone ? { source_timezone: prepared.source_timezone } : {}),
                ...(activityWarnings?.length ? { activity_warnings: activityWarnings } : {}),
                ...(prepared.activity ? { activity_used_fields: prepared.activity.usedFields } : {}),
                ...(prepared.notes.length ? { resolved_lookups: lookupNotesStructured(prepared.notes) } : {}),
                value_origins: buildValueOrigins({
                  values: { ...prepared.data, Id: plannedId },
                  callerValues: params.data,
                  lookups: prepared.notes,
                  coerced: prepared.coerced,
                  originSources: prepared.origins,
                  platformDefaults: (await services.metadataManager.getEntityMetadata(collection)).properties
                    .filter(
                      (property) =>
                        !Object.hasOwn(prepared.data, property.name) && property.defaultHint?.providedByServer
                    )
                    .map((property) => ({ field: property.name, observed: false })),
                  computedFields: params.data.Id === undefined ? ['Id'] : [],
                }),
                line_items_notes: line.notes,
              },
            };
          }
          if (prepared.blockers.length) {
            const missing = prepared.blockers.flatMap((blocker) => blocker.missing_fields ?? []);
            return {
              content: [
                { type: 'text', text: prepared.blockers.map((blocker) => blocker.message).join('\n') },
              ],
              structuredContent: {
                code: 'validation',
                message: 'Подготовка записи выявила блокеры. Ничего не создано.',
                next_steps: ['Исправьте обязательные поля и lookup-значения, затем повторите вызов.'],
                normalized_args: normalizedArgs,
                normalized_args_status: 'incomplete',
                blockers: prepared.blockers,
                clarifications: buildClarifications(prepared.blockers),
                changes: preparedChanges.changes,
                ...(preparedChanges.warnings.length
                  ? { presentation_warnings: preparedChanges.warnings }
                  : {}),
                ...(prepared.source_timezone ? { source_timezone: prepared.source_timezone } : {}),
                ...(activityWarnings?.length ? { activity_warnings: activityWarnings } : {}),
                ...(missing.length ? { missing_fields: missing } : {}),
              },
              isError: true,
            };
          }
          const resolved = { data, notes: prepared.notes, coerced: prepared.coerced };
          if (prepared.activity) {
            reservePreparedActivity(resolutionContext, prepared.activity);
            activityReservation = { context: resolutionContext, prepared: prepared.activity };
          }
          const creation = await services.odataClient.createRecordWithOutcome<Record<string, unknown>>(
            collection,
            resolved.data,
            { id: plannedId }
          );
          const created = creation.record;
          mutationCompleted = true;
          const changedFields = Object.keys(data);
          const resultChanges = await previewWriteChanges(
            services,
            collection,
            undefined,
            Object.fromEntries(
              changedFields.map((field) => [
                field,
                Object.prototype.hasOwnProperty.call(created, field) ? created[field] : data[field],
              ])
            )
          );
          const responseCoversChanges =
            creation.created === true && changedFields.every((field) => Object.hasOwn(created, field));
          const output = {
            collection,
            record: created,
            created: creation.created,
            normalized_args: normalizedArgs,
            ...(prepared.source_timezone ? { source_timezone: prepared.source_timezone } : {}),
            ...(activityWarnings?.length ? { activity_warnings: activityWarnings } : {}),
            ...(prepared.activity ? { activity_used_fields: prepared.activity.usedFields } : {}),
            changes: resultChanges.changes,
            changes_basis: responseCoversChanges ? 'observed_response' : 'requested',
            ...(resultChanges.warnings.length ? { presentation_warnings: resultChanges.warnings } : {}),
            ...(resolved.notes.length ? { resolved_lookups: lookupNotesStructured(resolved.notes) } : {}),
            value_origins: buildValueOrigins({
              values: { ...resolved.data, Id: plannedId, ...created },
              callerValues: params.data,
              lookups: resolved.notes,
              coerced: resolved.coerced,
              originSources: prepared.origins,
              computedFields: params.data.Id === undefined ? ['Id'] : [],
              platformDefaults: (await services.metadataManager.getEntityMetadata(collection)).properties
                .filter(
                  (property) =>
                    !Object.hasOwn(resolved.data, property.name) && property.defaultHint?.providedByServer
                )
                .map((property) => ({
                  field: property.name,
                  observed: Object.hasOwn(created, property.name),
                  value: created[property.name],
                })),
            }),
          };
          const lineNotes = [
            ...line.notes,
            ...(creation.created === null
              ? line.parents.length
                ? [
                    'Суммы родителей не пересчитаны: запись обнаружена после неопределённого ответа. Проверьте её перед пересчётом.',
                  ]
                : []
              : await recalcParentTotals(services, collection, line.parents)),
          ];
          const summary = await safeRecordSummary(
            services,
            collection,
            created,
            `${creation.created === true ? 'Запись создана' : 'Запись обнаружена'} в ${collection}:`
          );
          return {
            content: [
              {
                type: 'text',
                text: [
                  ...summary,
                  writeChangesText(resultChanges.changes) ?? '',
                  lookupNotesText(resolved.notes) ?? '',
                  coercedText(resolved.coerced) ?? '',
                  lineNotesText(lineNotes),
                ]
                  .filter(Boolean)
                  .join('\n'),
              },
            ],
            structuredContent: { ...output, ...(lineNotes.length ? { line_items_notes: lineNotes } : {}) },
          };
        } catch (error) {
          if (activityReservation)
            releasePreparedActivity(activityReservation.context, activityReservation.prepared);
          return errorResult(error, params.collection, {
            ...(plannedId
              ? { id: plannedId, state: mutationCompleted ? 'succeeded' : writeFailureState(error) }
              : {}),
            ...(plannedId && !mutationCompleted && writeFailureState(error) === 'outcome_unknown'
              ? {
                  verification_args: {
                    collection: normalizedArgs?.collection ?? params.collection,
                    id: plannedId,
                    verify: {
                      operation: 'create',
                      expected: Object.fromEntries(
                        Object.entries(
                          (normalizedArgs?.data as Record<string, unknown> | undefined) ?? {}
                        ).filter(([field]) => field !== 'Id')
                      ),
                    },
                  },
                }
              : {}),
            ...(normalizedArgs ? { normalized_args: normalizedArgs } : {}),
            ...(preparedForOutput?.source_timezone
              ? { source_timezone: preparedForOutput.source_timezone }
              : {}),
            ...(preparedForOutput?.activity?.warnings.length
              ? { activity_warnings: preparedForOutput.activity.warnings }
              : {}),
          });
        }
      }
    );
  }
  {
    const meta = getTool('bpm_update_record');
    server.registerTool(
      meta.name,
      {
        title: meta.title,
        description: meta.description,
        annotations: meta.annotations,
        inputSchema: {
          collection: z.string(),
          id: z.string().optional(),
          match_by: matchBySchema.optional(),
          data: recordShape.optional(),
          operations: z.array(updateOperationSchema).max(100).optional(),
          dry_run: z.boolean().optional(),
          expected_etag: etagParam,
        },
        outputSchema: {
          collection: z.string(),
          id: z.string(),
          matched: z.string().optional(),
          matched_by: matchedByShape.optional(),
          value_origins: z.array(valueOriginShape).optional(),
          record: recordShape.optional(),
          updated_fields: z.array(z.string()),
          dry_run: z.boolean().optional(),
          ready: z.boolean().optional(),
          normalized_args: z.record(z.string(), z.unknown()).optional(),
          normalized_args_status: z.enum(['complete', 'incomplete']).optional(),
          blockers: z.array(z.record(z.string(), z.unknown())).optional(),
          clarifications: z.array(z.record(z.string(), z.unknown())).optional(),
          changes: z.array(z.record(z.string(), z.unknown())).optional(),
          changes_basis: z.enum(['observed_response', 'requested']).optional(),
          presentation_warnings: z.array(z.string()).optional(),
          no_changes: z.boolean().optional(),
          missing_fields: z
            .array(z.object({ name: z.string(), caption: z.string(), type: z.string() }))
            .optional(),
          before: recordShape.optional(),
          after: recordShape.optional(),
          concurrency_protection: z.enum(['etag', 'snapshot_only']).optional(),
          source_timezone: z
            .object({ time_zone: z.string(), source: z.enum(['profile', 'environment']) })
            .optional(),
          resolved_lookups: z.array(resolvedLookupNoteShape).optional(),
          line_items_notes: lineItemsNotesShape,
          verification_args: verificationArgsShape.optional(),
        },
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        let executionStarted = false;
        let mutationCompleted = false;
        let normalizedArgs: Record<string, unknown> | undefined;
        try {
          await services.authManager.ensureAuthenticated();
          const collection = await collectionName(services, params.collection);
          const target = await resolveRecordTarget(services, collection, params);
          const operations = (params.operations ?? []) as UpdateOperation[];
          const context = createCreateResolutionContext(services);
          const prepared =
            operations.length || params.dry_run
              ? await prepareUpdateIntent(
                  services,
                  collection,
                  target.id,
                  params.data ?? {},
                  operations,
                  undefined,
                  context
                )
              : undefined;
          const expectedEtag = params.expected_etag ?? (prepared ? recordEtag(prepared.snapshot) : undefined);
          const snapshotEtag = prepared ? recordEtag(prepared.snapshot) : undefined;
          if (prepared && params.expected_etag) {
            if (!/^(?:W\/)?"[^"\r\n]+"$/.test(params.expected_etag)) {
              prepared.blockers.push({
                code: 'invalid_expected_etag',
                message: 'expected_etag должен быть конкретной версией записи.',
              });
            } else if (!snapshotEtag) {
              prepared.blockers.push({
                code: 'concurrency_unsupported',
                message: 'Снимок записи не содержит ETag; условное изменение не поддерживается.',
              });
            } else if (params.expected_etag !== snapshotEtag) {
              prepared.blockers.push({
                code: 'concurrency_conflict',
                message: 'Ожидаемый ETag не совпадает со снимком записи; обновление не подготовлено.',
              });
            }
          }
          if (prepared?.blockers.length) {
            const missingFields = prepared.blockers.flatMap((blocker) => blocker.missing_fields ?? []);
            normalizedArgs = {
              collection,
              id: target.id,
              data: prepared.data,
              ...(expectedEtag ? { expected_etag: expectedEtag } : {}),
            };
            return {
              content: [
                { type: 'text', text: prepared.blockers.map((blocker) => blocker.message).join('\n') },
              ],
              structuredContent: {
                collection,
                id: target.id,
                dry_run: Boolean(params.dry_run),
                ready: false,
                blockers: prepared.blockers,
                clarifications: buildClarifications(prepared.blockers),
                updated_fields: Object.keys(prepared.data),
                normalized_args: normalizedArgs,
                normalized_args_status: 'incomplete',
                ...(missingFields.length ? { missing_fields: missingFields } : {}),
              },
              ...(!params.dry_run ? { isError: true } : {}),
            };
          }
          if (prepared?.no_changes) {
            normalizedArgs = {
              collection,
              id: target.id,
              data: {},
              ...(expectedEtag ? { expected_etag: expectedEtag } : {}),
            };
            return {
              content: [{ type: 'text', text: 'Изменения не требуются: заполненные поля не изменены.' }],
              structuredContent: {
                collection,
                id: target.id,
                dry_run: Boolean(params.dry_run),
                ready: true,
                no_changes: true,
                blockers: [],
                changes: [],
                normalized_args: normalizedArgs,
                updated_fields: [],
                concurrency_protection: expectedEtag ? 'etag' : prepared.concurrency_protection,
                ...(prepared.source_timezone ? { source_timezone: prepared.source_timezone } : {}),
              },
            };
          }
          const resolved = prepared
            ? { data: prepared.data, notes: prepared.notes, coerced: prepared.coerced }
            : await services.lookupResolver.resolveDataLookups(collection, params.data ?? {}, context);
          if (!Object.keys(resolved.data).length)
            throw new BpmApiError('Не переданы поля для обновления.', 400, collection);
          if ('Id' in resolved.data)
            throw new BpmApiError('UUID записи нельзя менять. Передайте его через id.', 400, collection);
          const line = await enrichLineItem(services, collection, resolved.data, { id: target.id });
          resolved.data = line.data;
          let beforeForDiff = prepared?.before;
          let beforeReadUnavailable = false;
          if (!beforeForDiff) {
            try {
              beforeForDiff = await services.odataClient.getRecord<Record<string, unknown>>(
                collection,
                target.id,
                { $select: ['Id', ...Object.keys(line.data)].join(',') }
              );
            } catch {
              beforeReadUnavailable = true;
            }
          }
          const plannedDiff = await previewWriteChanges(
            services,
            collection,
            beforeForDiff,
            Object.fromEntries(Object.keys(line.data).map((field) => [field, line.data[field]]))
          );
          normalizedArgs = {
            collection,
            id: target.id,
            data: line.data,
            ...(expectedEtag ? { expected_etag: expectedEtag } : {}),
          };
          if (params.dry_run)
            return {
              content: [{ type: 'text', text: 'Подготовка пройдена. Запись не изменена.' }],
              structuredContent: {
                collection,
                id: target.id,
                ...(target.matched ? { matched: target.matched } : {}),
                ...(target.matched_by ? { matched_by: target.matched_by } : {}),
                dry_run: true,
                ready: true,
                blockers: [],
                clarifications: [],
                changes: plannedDiff.changes,
                ...(beforeReadUnavailable || plannedDiff.warnings.length
                  ? {
                      presentation_warnings: [
                        ...(beforeReadUnavailable
                          ? ['Предыдущее состояние недоступно; показаны только запрошенные значения.']
                          : []),
                        ...plannedDiff.warnings,
                      ],
                    }
                  : {}),
                normalized_args: normalizedArgs,
                ...(prepared
                  ? {
                      before: prepared.before,
                      after: { ...prepared.after, ...line.data },
                      concurrency_protection: expectedEtag ? 'etag' : prepared.concurrency_protection,
                      ...(prepared.source_timezone ? { source_timezone: prepared.source_timezone } : {}),
                    }
                  : {}),
                updated_fields: Object.keys(line.data),
                ...(resolved.notes.length ? { resolved_lookups: lookupNotesStructured(resolved.notes) } : {}),
                value_origins: buildValueOrigins({
                  values: line.data,
                  callerValues: params.data,
                  lookups: resolved.notes,
                  coerced: resolved.coerced,
                  originSources: prepared?.origins ?? ('origins' in resolved ? resolved.origins : []),
                  computedFields: (params.operations ?? []).map((operation) => operation.field),
                }),
              },
            };
          executionStarted = true;
          const updated = await services.odataClient.updateRecord<Record<string, unknown>>(
            collection,
            target.id,
            resolved.data,
            {
              expectedEtag,
              returnRepresentation: true,
            }
          );
          mutationCompleted = true;
          const responseCoversChanges = Boolean(
            updated &&
            Object.keys(line.data).every((field) => Object.prototype.hasOwnProperty.call(updated, field))
          );
          const resultDiff = await previewWriteChanges(
            services,
            collection,
            beforeForDiff,
            Object.fromEntries(
              Object.keys(line.data).map((field) => [
                field,
                responseCoversChanges ? updated![field] : line.data[field],
              ])
            )
          );
          const lineNotes = [
            ...line.notes,
            ...(await recalcParentTotals(services, collection, line.parents)),
          ];
          const output = {
            collection,
            id: target.id,
            ...(target.matched ? { matched: target.matched } : {}),
            ...(target.matched_by ? { matched_by: target.matched_by } : {}),
            ...(updated ? { record: updated } : {}),
            normalized_args: normalizedArgs,
            ...(prepared
              ? {
                  before: prepared.before,
                  after: { ...prepared.after, ...line.data },
                  concurrency_protection: expectedEtag ? 'etag' : prepared.concurrency_protection,
                  ready: true,
                  blockers: [],
                  ...(prepared.source_timezone ? { source_timezone: prepared.source_timezone } : {}),
                }
              : {}),
            ...(lineNotes.length ? { line_items_notes: lineNotes } : {}),
            updated_fields: Object.keys(resolved.data),
            changes: resultDiff.changes,
            changes_basis:
              responseCoversChanges && !beforeReadUnavailable ? 'observed_response' : 'requested',
            ...(beforeReadUnavailable || resultDiff.warnings.length
              ? {
                  presentation_warnings: [
                    ...(beforeReadUnavailable
                      ? ['Предыдущее состояние недоступно; показаны только запрошенные значения.']
                      : []),
                    ...resultDiff.warnings,
                  ],
                }
              : {}),
            ...(resolved.notes.length ? { resolved_lookups: lookupNotesStructured(resolved.notes) } : {}),
            value_origins: buildValueOrigins({
              values: line.data,
              callerValues: params.data,
              lookups: resolved.notes,
              coerced: resolved.coerced,
              originSources: prepared?.origins ?? ('origins' in resolved ? resolved.origins : []),
              computedFields: (params.operations ?? []).map((operation) => operation.field),
            }),
          };
          return {
            content: [
              {
                type: 'text',
                text: [
                  ...(target.matched ? [`Найдена запись по имени: «${target.matched}» (${target.id})`] : []),
                  ...(updated
                    ? await safeRecordSummary(
                        services,
                        collection,
                        updated,
                        `Запись ${collection} обновлена:`
                      )
                    : [`Запись ${collection}(${target.id}) обновлена.`]),
                  `Обновлённые поля: ${output.updated_fields.join(', ')}`,
                  writeChangesText(resultDiff.changes) ?? '',
                  lookupNotesText(resolved.notes) ?? '',
                  coercedText(resolved.coerced) ?? '',
                  lineNotesText(lineNotes),
                ]
                  .filter(Boolean)
                  .join('\n'),
              },
            ],
            structuredContent: output,
          };
        } catch (error) {
          return errorResult(error, params.collection, {
            id: normalizedArgs?.id ?? params.id ?? '',
            state: executionStarted
              ? mutationCompleted
                ? 'succeeded'
                : writeFailureState(error)
              : 'not_executed',
            ...(executionStarted &&
            !mutationCompleted &&
            writeFailureState(error) === 'outcome_unknown' &&
            normalizedArgs
              ? {
                  verification_args: {
                    collection: normalizedArgs.collection,
                    id: normalizedArgs.id,
                    verify: { operation: 'update', expected: normalizedArgs.data },
                  },
                }
              : {}),
            ready: false,
            updated_fields: [],
            blockers: [
              {
                code: error instanceof BpmApiError ? error.code : 'validation',
                message: error instanceof Error ? error.message : String(error),
              },
            ],
            clarifications: buildClarifications([writeToolError(error, params.collection)]),
            ...(normalizedArgs ? { normalized_args: normalizedArgs } : {}),
          });
        }
      }
    );
  }
  {
    const meta = getTool('bpm_delete_record');
    server.registerTool(
      meta.name,
      {
        title: meta.title,
        description: meta.description,
        annotations: meta.annotations,
        inputSchema: {
          collection: z.string(),
          id: z.string().optional(),
          match_by: matchBySchema.optional(),
          confirm: confirmParam,
          confirmation_token: confirmationTokenParam,
          expected_etag: etagParam,
        },
        outputSchema: {
          ...planShape,
          collection: z.string(),
          id: z.string(),
          deleted: z.boolean().optional(),
          record: recordShape.optional(),
          matched: z.string().optional(),
          matched_by: matchedByShape.optional(),
          line_items_notes: lineItemsNotesShape,
          verification_args: verificationArgsShape.optional(),
        },
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        let executionStarted = false;
        let verificationTarget: { collection: string; id: string } | undefined;
        try {
          await services.authManager.ensureAuthenticated();
          const collection = await collectionName(services, params.collection);
          const target = await resolveRecordTarget(services, collection, params, { fuzzy: false });
          verificationTarget = { collection, id: target.id };
          const record = await services.odataClient.getRecord<Record<string, unknown>>(collection, target.id);
          const operation = {
            tool: meta.name,
            collection,
            input_id: params.id,
            id: target.id,
            record,
            expected_etag: params.expected_etag,
          };
          const freshness = {
            intent: {
              tool: meta.name,
              collection,
              id: params.id,
              match_by: params.match_by,
              expected_etag: params.expected_etag,
            },
            snapshots: [
              {
                index: 0,
                id: target.id,
                values: Object.fromEntries(
                  Object.entries(record).filter(([field]) => !field.startsWith('@odata.'))
                ),
              },
            ],
          };
          if (params.confirm !== true) {
            return confirmationResponse(
              meta.name,
              [
                ...(target.matched ? [`Найдена запись по имени: «${target.matched}» (${target.id})`] : []),
                ...(await recordSummary(services, collection, record, `Будет удалена запись ${collection}:`)),
              ],
              {
                collection,
                id: target.id,
                ...(target.matched ? { matched: target.matched } : {}),
                ...(target.matched_by ? { matched_by: target.matched_by } : {}),
                record,
                records: previewRecordSummary([record]),
                concurrency_protection: concurrencyProtection([record]),
                confirmation_token: createConfirmationPlan(services, operation, freshness),
              }
            );
          }
          const stale = consumeConfirmationPlan(services, params.confirmation_token, operation, freshness);
          if (stale)
            return confirmationResponse(
              meta.name,
              [
                'Запись изменилась после предварительного просмотра. Ничего не удалено; проверьте текущие значения и подтвердите новый план отдельно.',
              ],
              {
                collection,
                id: target.id,
                ...(target.matched_by ? { matched_by: target.matched_by } : {}),
                record,
                conflict: { changed: stale.changed },
                records: previewRecordSummary([record]),
                concurrency_protection: concurrencyProtection([record]),
                confirmation_token: createConfirmationPlan(services, operation, freshness),
              }
            );
          const parents = await lineParentIds(services, collection, [target.id]);
          executionStarted = true;
          await services.odataClient.deleteRecord(collection, target.id, {
            expectedEtag: params.expected_etag ?? recordEtag(record),
          });
          const lineNotes = await recalcParentTotals(services, collection, parents);
          return {
            content: [
              {
                type: 'text',
                text: [`Запись ${collection}(${target.id}) удалена.`, lineNotesText(lineNotes)]
                  .filter(Boolean)
                  .join('\n'),
              },
            ],
            structuredContent: {
              collection,
              id: target.id,
              deleted: true,
              ...(target.matched ? { matched: target.matched } : {}),
              ...(target.matched_by ? { matched_by: target.matched_by } : {}),
              ...(lineNotes.length ? { line_items_notes: lineNotes } : {}),
            },
          };
        } catch (error) {
          return errorResult(error, params.collection, {
            id: verificationTarget?.id ?? params.id,
            state: executionStarted ? writeFailureState(error) : 'not_executed',
            ...(executionStarted && writeFailureState(error) === 'outcome_unknown' && verificationTarget
              ? {
                  verification_args: {
                    collection: verificationTarget.collection,
                    id: verificationTarget.id,
                    verify: { operation: 'delete' },
                  },
                }
              : {}),
          });
        }
      }
    );
  }
  for (const toolName of ['bpm_update_by_filter', 'bpm_delete_by_filter'] as const) {
    const meta = getTool(toolName);
    const isUpdate = toolName === 'bpm_update_by_filter';
    server.registerTool(
      meta.name,
      {
        title: meta.title,
        description: meta.description,
        annotations: meta.annotations,
        inputSchema: isUpdate
          ? z.object({
              collection: z.string(),
              filter: z.string().trim().min(1).optional(),
              criteria: z.array(criterionSchema).min(1).max(100).optional(),
              join: z.enum(['and', 'or']).optional(),
              expected_count: z.number().int().min(1).max(1000).optional(),
              data: recordShape.describe(
                'Поля для обновления. Сначала возвращается план с точными UUID; изменение выполняется после подтверждения этого плана.'
              ),
              confirm: confirmParam,
              confirmation_token: confirmationTokenParam,
            })
          : z.object({
              collection: z.string(),
              filter: z.string().trim().min(1).optional(),
              criteria: z.array(criterionSchema).min(1).max(100).optional(),
              join: z.enum(['and', 'or']).optional(),
              expected_count: z.number().int().min(1).max(1000).optional(),
              confirm: confirmParam,
              confirmation_token: confirmationTokenParam,
            }),
        outputSchema: {
          ...planShape,
          collection: z.string(),
          filter: z.string().optional(),
          compiled_filter: z.string().optional(),
          used_fields: z
            .array(z.object({ input: z.string(), resolved: z.string(), caption: z.string().optional() }))
            .optional(),
          warnings: z.array(z.string()).optional(),
          count: z.number().int().optional(),
          ids: z.array(z.string()).optional(),
          data: recordShape.optional(),
          outcomes: z.array(outcomeShape).optional(),
          succeeded: z.array(z.string()).optional(),
          failed: z.array(z.object({ id: z.string(), error: z.string() })).optional(),
          resolved_lookups: z.array(resolvedLookupNoteShape).optional(),
          line_items_notes: lineItemsNotesShape,
          found: z.number().int().optional(),
          names: z.array(z.string()).optional(),
          has_more: z.boolean().optional(),
          changes: z
            .array(
              z.object({
                id: z.string(),
                data: recordShape,
                fields: z.array(z.object({ field: z.string(), caption: z.string(), value: z.unknown() })),
              })
            )
            .optional(),
        },
      },
      async (params: {
        collection: string;
        filter?: string;
        criteria?: Criterion[];
        join?: 'and' | 'or';
        expected_count?: number;
        data?: Record<string, unknown>;
        confirm?: boolean;
        confirmation_token?: string;
      }): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        try {
          await services.authManager.ensureAuthenticated();
          const collection = await collectionName(services, params.collection);
          const hasFilter = params.filter !== undefined;
          const hasCriteria = params.criteria !== undefined;
          if (!hasFilter && !hasCriteria)
            throw new BpmApiError('Передайте criteria или filter.', 400, collection);
          if (hasFilter && (typeof params.filter !== 'string' || !params.filter.trim()))
            throw new BpmApiError('filter должен содержать непустое условие.', 400, collection);
          if (
            hasCriteria &&
            (!Array.isArray(params.criteria) || !params.criteria.length || params.criteria.length > 100)
          )
            throw new BpmApiError('criteria должен содержать от 1 до 100 условий.', 400, collection);
          if (params.join !== undefined && params.join !== 'and' && params.join !== 'or')
            throw new BpmApiError('join должен быть and или or.', 400, collection);
          const compiled = hasCriteria
            ? await compileCriteria(services, collection, params.criteria!, params.join)
            : { filter: '', used_fields: [], warnings: [] };
          compiled.filter = combineFilters(params.filter, compiled.filter) ?? '';
          const filterOutput = {
            ...(hasFilter ? { filter: params.filter } : {}),
            compiled_filter: compiled.filter,
            used_fields: compiled.used_fields,
            warnings: compiled.warnings,
          };
          if (!isUpdate && params.data !== undefined)
            throw new BpmApiError('data применимо только к обновлению.', 400, collection);
          if (isUpdate && (!params.data || !Object.keys(params.data).length))
            throw new BpmApiError('Передайте непустой data для обновления.', 400, collection);
          const resolved = isUpdate
            ? await services.lookupResolver.resolveDataLookups(collection, params.data!)
            : { data: {}, notes: [] };
          if ('Id' in resolved.data) throw new BpmApiError('UUID записи нельзя менять.', 400, collection);
          if (params.expected_count === undefined) {
            if (params.confirm === true)
              throw new BpmApiError(
                'Для выполнения нужен expected_count и подтверждённый план.',
                400,
                collection
              );
            const display = await getDisplayColumn(services.metadataManager, collection);
            const result = await services.odataClient.getRecords<Record<string, unknown>>(
              collection,
              {
                $filter: compiled.filter,
                $select: display ? `Id,${display}` : 'Id',
                $top: 1001,
                $orderby: 'Id',
                $count: true,
              },
              true,
              1001
            );
            const summaries = previewRecordSummary(result.value);
            const hasMore =
              !!result['@odata.nextLink'] ||
              result.value.length > 1000 ||
              (result['@odata.count'] !== undefined && result['@odata.count'] > result.value.length);
            const output = {
              code: 'expected_count_required',
              collection,
              ...filterOutput,
              found: result['@odata.count'] ?? result.value.length,
              ids: summaries.slice(0, 1000).map((record) => record.id),
              names: summaries.slice(0, 1000).map((record) => record.display_value),
              records: summaries.slice(0, 1000),
              has_more: hasMore,
              ...(resolved.notes.length ? { resolved_lookups: lookupNotesStructured(resolved.notes) } : {}),
            };
            return {
              content: [
                {
                  type: 'text',
                  text: `По условию найдено ${output.found}${hasMore && result['@odata.count'] === undefined ? '+' : ''} записей в ${collection}: ${summaries
                    .slice(0, 1000)
                    .map((record) => `${record.display_value} (${record.id})`)
                    .join(
                      ', '
                    )}. Ничего не изменено. Передайте expected_count${!hasMore ? `=${output.found}` : ''} для точного плана, затем confirm=true и confirmation_token.`,
                },
              ],
              structuredContent: output,
            };
          }
          const records = await selectExactRecords(
            services,
            collection,
            compiled.filter,
            params.expected_count
          );
          const ids = records.map(recordId);
          const lines = isUpdate
            ? await Promise.all(
                records.map(async (record) => ({
                  id: recordId(record),
                  ...(await enrichLineItem(services, collection, resolved.data, {
                    id: recordId(record),
                    record,
                  })),
                }))
              )
            : [];
          const deletionParents = isUpdate ? [] : snapshotLineParents(collection, records);
          const operation = {
            tool: meta.name,
            collection,
            filter: params.filter,
            criteria: params.criteria,
            join: params.join ?? 'and',
            expected_count: params.expected_count,
            records,
            data: resolved.data,
            changes: lines.map((line) => ({
              id: line.id,
              data: line.data,
              parents: [...line.parents].sort(),
            })),
            deletion_parents: [...deletionParents].sort(),
          };
          const freshness = {
            intent: {
              tool: meta.name,
              collection,
              filter: params.filter,
              criteria: params.criteria,
              join: params.join ?? 'and',
              expected_count: params.expected_count,
              data: resolved.data,
              ids,
            },
            snapshots: records.map((record, index) => ({
              index,
              id: recordId(record),
              values: Object.fromEntries(
                Object.entries(record).filter(([field]) => !field.startsWith('@odata.'))
              ),
            })),
          };
          if (params.confirm !== true) {
            return confirmationResponse(
              meta.name,
              [
                `Будет ${isUpdate ? 'обновлено' : 'удалено'} ${ids.length} записей в ${collection}:`,
                previewIdList(
                  previewRecordSummary(records).map((record) => `${record.display_value} (${record.id})`)
                ),
                ...(isUpdate ? [JSON.stringify(resolved.data, null, 2)] : []),
              ],
              {
                collection,
                ...filterOutput,
                count: ids.length,
                ids,
                records: previewRecordSummary(records),
                concurrency_protection: concurrencyProtection(records),
                ...(isUpdate
                  ? {
                      data: resolved.data,
                      data_fields: await previewWriteFields(services, collection, resolved.data),
                      changes: await Promise.all(
                        lines.map(async (line) => ({
                          id: line.id,
                          data: line.data,
                          fields: await previewWriteFields(services, collection, line.data),
                        }))
                      ),
                    }
                  : {}),
                confirmation_token: createConfirmationPlan(services, operation, freshness),
              }
            );
          }
          const stale = consumeConfirmationPlan(services, params.confirmation_token, operation, freshness);
          if (stale) {
            return confirmationResponse(
              meta.name,
              [
                'Снимок изменился после предварительного просмотра. Записи не изменены; проверьте обновлённый план.',
              ],
              {
                collection,
                ...filterOutput,
                count: ids.length,
                ids,
                records: previewRecordSummary(records),
                conflict: { changed: stale.changed },
                concurrency_protection: concurrencyProtection(records),
                ...(isUpdate
                  ? { data: resolved.data, changes: lines.map((line) => ({ id: line.id, data: line.data })) }
                  : {}),
                confirmation_token: createConfirmationPlan(services, operation, freshness),
              }
            );
          }
          const outcomes = await executeSequentialWrites(records, async (id, expectedEtag) => {
            if (isUpdate)
              await services.odataClient.updateRecord(
                collection,
                id,
                lines.find((line) => line.id === id)!.data,
                { expectedEtag }
              );
            else await services.odataClient.deleteRecord(collection, id, { expectedEtag });
          });
          const succeeded = outcomes.filter((o) => o.state === 'succeeded').map((o) => o.id);
          const parentIds = isUpdate
            ? lines.filter((line) => succeeded.includes(line.id)).flatMap((line) => line.parents)
            : snapshotLineParents(
                collection,
                records.filter((record) => succeeded.includes(recordId(record)))
              );
          const uncertain = outcomes.some((outcome) => outcome.state === 'outcome_unknown');
          const lineNotes = [
            ...lines.flatMap((line) => line.notes),
            ...(uncertain
              ? lineConfig(collection)?.parent
                ? [
                    'Суммы родителей не пересчитаны: исход одного из изменений неопределён. Проверьте outcomes перед пересчётом.',
                  ]
                : []
              : await recalcParentTotals(services, collection, succeeded.length ? parentIds : [])),
          ];
          const failed = outcomes
            .filter((o) => o.state === 'failed' || o.state === 'outcome_unknown')
            .map((o) => ({ id: o.id, error: o.error ?? o.state }));
          const output = {
            collection,
            ...filterOutput,
            outcomes,
            succeeded,
            failed,
            ...(lineNotes.length ? { line_items_notes: lineNotes } : {}),
            ...(resolved.notes.length ? { resolved_lookups: lookupNotesStructured(resolved.notes) } : {}),
          };
          return {
            content: [
              {
                type: 'text',
                text: `${isUpdate ? 'Обновление' : 'Удаление'} ${collection}: выполнено ${succeeded.length}/${ids.length}.\n${JSON.stringify(outcomes, null, 2)}`,
              },
            ],
            structuredContent: output,
            isError: succeeded.length !== ids.length,
          };
        } catch (error) {
          return errorResult(error, params.collection);
        }
      }
    );
  }
}

// Кто и когда создал/изменил — только что сделал сам вызывающий; модели это не нужно.
const AUDIT_COLUMNS = new Set(['CreatedOn', 'CreatedById', 'ModifiedOn', 'ModifiedById']);

async function recordSummary(
  services: ServiceContainer,
  collection: string,
  record: Record<string, unknown>,
  heading: string
): Promise<string[]> {
  const column = await getDisplayColumn(services.metadataManager, collection);
  const id = String(record.Id ?? record.id ?? '');
  const name = column && record[column] ? `«${String(record[column])}» ` : '';
  const fields = Object.entries(compactRecord(record))
    .filter(([key]) => key !== 'Id' && key !== column && !AUDIT_COLUMNS.has(key))
    .map(([key, value]) => `  ${key}: ${String(value)}`);
  return [`${heading} ${name}(${id})`, ...fields];
}
