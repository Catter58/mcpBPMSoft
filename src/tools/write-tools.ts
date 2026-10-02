/** Write tools validate intent before changes and bind bulk confirmation to a snapshot. */
import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceContainer } from './init-tool.js';
import { BpmApiError, UnknownCollectionError } from '../utils/errors.js';
import { getTool } from './registry.js';
import {
  notInitialized,
  lookupNotesStructured,
  lookupNotesText,
  resolveRecordId,
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
import { criterionSchema, recordShape, resolvedLookupNoteShape, lineItemsNotesShape } from './_schemas.js';
import type { Criterion } from '../utils/filter-compiler.js';
import { isGuid } from '../utils/odata.js';
import {
  executeSequentialWrites,
  creationRecordId,
  validateIdempotencyKey,
  validateRequiredCreateFields,
  writeToolError,
  previewRecordSummary,
  concurrencyProtection,
  previewWriteFields,
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
};
const outcomeShape = z.object({
  id: z.string(),
  state: z.enum(['succeeded', 'failed', 'not_executed', 'outcome_unknown']),
  error: z.string().optional(),
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
        },
        outputSchema: {
          collection: z.string(),
          record: recordShape,
          created: z.boolean().nullable().optional(),
          resolved_lookups: z.array(resolvedLookupNoteShape).optional(),
          line_items_notes: lineItemsNotesShape,
        },
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        let plannedId: string | undefined;
        try {
          await services.authManager.ensureAuthenticated();
          validateIdempotencyKey(params.idempotency_key);
          const collection = await collectionName(services, params.collection);
          const resolved = await services.lookupResolver.resolveDataLookups(collection, params.data);
          const line = await enrichLineItem(services, collection, resolved.data);
          resolved.data = line.data;
          await validateRequiredCreateFields(services, collection, resolved.data);
          plannedId = creationRecordId(
            services,
            resolved.data,
            params.idempotency_key,
            `${collection}:create`
          );
          const creation = await services.odataClient.createRecordWithOutcome<Record<string, unknown>>(
            collection,
            resolved.data,
            { id: plannedId }
          );
          const created = creation.record;
          const output = {
            collection,
            record: created,
            created: creation.created,
            ...(resolved.notes.length ? { resolved_lookups: lookupNotesStructured(resolved.notes) } : {}),
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
          const summary = await recordSummary(
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
          return errorResult(
            error,
            params.collection,
            plannedId ? { id: plannedId, state: writeFailureState(error) } : {}
          );
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
          id: z.string(),
          data: recordShape,
          expected_etag: etagParam,
        },
        outputSchema: {
          collection: z.string(),
          id: z.string(),
          matched: z.string().optional(),
          record: recordShape.optional(),
          updated_fields: z.array(z.string()),
          resolved_lookups: z.array(resolvedLookupNoteShape).optional(),
          line_items_notes: lineItemsNotesShape,
        },
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        let executionStarted = false;
        try {
          await services.authManager.ensureAuthenticated();
          const collection = await collectionName(services, params.collection);
          const target = await resolveRecordId(services, collection, params.id);
          const resolved = await services.lookupResolver.resolveDataLookups(collection, params.data);
          if (!Object.keys(resolved.data).length)
            throw new BpmApiError('Не переданы поля для обновления.', 400, collection);
          if ('Id' in resolved.data)
            throw new BpmApiError('UUID записи нельзя менять. Передайте его через id.', 400, collection);
          const line = await enrichLineItem(services, collection, resolved.data, { id: target.id });
          resolved.data = line.data;
          executionStarted = true;
          const updated = await services.odataClient.updateRecord<Record<string, unknown>>(
            collection,
            target.id,
            resolved.data,
            {
              expectedEtag: params.expected_etag,
              returnRepresentation: true,
            }
          );
          const lineNotes = [
            ...line.notes,
            ...(await recalcParentTotals(services, collection, line.parents)),
          ];
          const output = {
            collection,
            id: target.id,
            ...(target.matched ? { matched: target.matched } : {}),
            ...(updated ? { record: updated } : {}),
            ...(lineNotes.length ? { line_items_notes: lineNotes } : {}),
            updated_fields: Object.keys(resolved.data),
            ...(resolved.notes.length ? { resolved_lookups: lookupNotesStructured(resolved.notes) } : {}),
          };
          return {
            content: [
              {
                type: 'text',
                text: [
                  ...(target.matched ? [`Найдена запись по имени: «${target.matched}» (${target.id})`] : []),
                  ...(updated
                    ? await recordSummary(services, collection, updated, `Запись ${collection} обновлена:`)
                    : [`Запись ${collection}(${target.id}) обновлена.`]),
                  `Обновлённые поля: ${output.updated_fields.join(', ')}`,
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
            id: params.id,
            state: executionStarted ? writeFailureState(error) : 'not_executed',
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
          id: z.string(),
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
          line_items_notes: lineItemsNotesShape,
        },
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        let executionStarted = false;
        try {
          await services.authManager.ensureAuthenticated();
          const collection = await collectionName(services, params.collection);
          const target = await resolveRecordId(services, collection, params.id, { fuzzy: false });
          const record = await services.odataClient.getRecord<Record<string, unknown>>(collection, target.id);
          const operation = {
            tool: meta.name,
            collection,
            input_id: params.id,
            id: target.id,
            record,
            expected_etag: params.expected_etag,
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
                record,
                records: previewRecordSummary([record]),
                concurrency_protection: concurrencyProtection([record]),
                confirmation_token: createConfirmationPlan(services, operation),
              }
            );
          }
          consumeConfirmationPlan(services, params.confirmation_token, operation);
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
              ...(lineNotes.length ? { line_items_notes: lineNotes } : {}),
            },
          };
        } catch (error) {
          return errorResult(error, params.collection, {
            id: params.id,
            state: executionStarted ? writeFailureState(error) : 'not_executed',
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
                confirmation_token: createConfirmationPlan(services, operation),
              }
            );
          }
          consumeConfirmationPlan(services, params.confirmation_token, operation);
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
