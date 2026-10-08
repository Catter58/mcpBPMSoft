/** Separate planning from execution so composite workflows validate before a write. */
import type { ServiceContainer } from '../tools/init-tool.js';
import {
  BpmApiError,
  LookupResolutionError,
  UnknownCollectionError,
  UnknownFieldError,
} from '../utils/errors.js';
import { operationFingerprint } from '../utils/confirm.js';
import { literalizeFieldValue } from '../utils/field-values.js';
import {
  creationRecordIdWithScope,
  recordId,
  validateIdempotencyKey,
  type IdempotencyScope,
} from '../utils/write-safety.js';
import { assertPreparedCreate, prepareCreateIntent } from './create-preparation.js';
import type { ResolutionContext } from '../lookup/resolution-context.js';

export interface FindOrCreateResult {
  id: string;
  /** null: the record was reconciled after an uncertain write; creation cannot be attributed. */
  created: boolean | null;
  record: Record<string, unknown>;
}
export interface FindOrCreatePlan {
  collection: string;
  id: string;
  created: boolean;
  record?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

export async function prepareFindOrCreate(
  services: ServiceContainer,
  collection: string,
  matchOn: { field: string; value: string },
  createWith: Record<string, unknown>,
  idempotencyKey?: string,
  context?: ResolutionContext,
  idempotencyScope: IdempotencyScope = 'session'
): Promise<FindOrCreatePlan> {
  validateIdempotencyKey(idempotencyKey);
  if (!matchOn.value.trim()) throw new BpmApiError('Значение поиска не может быть пустым.', 400, collection);
  const collRef = await services.metadataManager.resolveCollectionReference(collection);
  if (collRef.name === null) throw new UnknownCollectionError(collection, collRef.suggestions);
  const resolvedCollection = collRef.name;
  const fieldRef = await services.metadataManager.resolveFieldReference(resolvedCollection, matchOn.field);
  if (fieldRef.name === null)
    throw new UnknownFieldError(matchOn.field, resolvedCollection, fieldRef.suggestions);
  const entity = await services.metadataManager.getEntityMetadata(resolvedCollection);
  const property = entity.properties.find((p) => p.name === fieldRef.name);
  if (!property) throw new UnknownFieldError(matchOn.field, resolvedCollection, []);
  const literal = literalizeFieldValue(
    matchOn.value,
    property,
    services.config?.odata_version ?? 4,
    resolvedCollection
  );
  const response = await services.odataClient.getRecords<Record<string, unknown>>(
    resolvedCollection,
    { $filter: `${property.name} eq ${literal}`, $top: 2 },
    true,
    2
  );
  if (
    response.value.length > 1 ||
    response['@odata.nextLink'] ||
    (response as unknown as { __next?: string }).__next
  ) {
    throw new BpmApiError(
      `Найдено несколько совпадений по ${property.name}='${matchOn.value}'. Уточните запись; ничего не создано.`,
      400,
      resolvedCollection
    );
  }
  if (response.value.length === 1) {
    const record = response.value[0];
    return { collection: resolvedCollection, id: recordId(record), created: false, record };
  }
  if (property.type === 'Edm.String') {
    const lookup = await services.lookupResolver.resolve(resolvedCollection, matchOn.value, property.name, {
      fuzzy: true,
    });
    if (lookup.resolved && lookup.id)
      return {
        collection: resolvedCollection,
        id: lookup.id,
        created: false,
        record: { Id: lookup.id, [property.name]: lookup.matchedValue ?? matchOn.value },
      };
    if (lookup.matchCount > 0)
      throw new LookupResolutionError(property.name, matchOn.value, lookup.matchCount, lookup.candidates, {
        lookupCollection: resolvedCollection,
        displayColumn: property.name,
      });
  }
  // Keep create preparation on the create branch; composite operations can
  // supply their shared snapshot while standalone calls create one lazily.
  const resolutionContext = context ?? services.lookupResolver.createResolutionContext();
  const prepared = await prepareCreateIntent(services, resolvedCollection, createWith, resolutionContext);
  assertPreparedCreate(prepared, resolvedCollection);
  const data = prepared.data;
  const creationKey =
    idempotencyKey ??
    (data.Id === undefined
      ? `find:${operationFingerprint({ collection: resolvedCollection, field: property.name, literal })}`
      : undefined);
  const id = await creationRecordIdWithScope(
    services,
    data,
    creationKey,
    `${resolvedCollection}:find-or-create`,
    idempotencyScope,
    resolutionContext
  );
  return { collection: resolvedCollection, id, created: true, data };
}

export async function executeFindOrCreate(
  services: ServiceContainer,
  plan: FindOrCreatePlan
): Promise<FindOrCreateResult> {
  if (!plan.created) return { id: plan.id, created: false, record: plan.record! };
  const outcome = await services.odataClient.createRecordWithOutcome<Record<string, unknown>>(
    plan.collection,
    plan.data!,
    { id: plan.id }
  );
  return { id: recordId(outcome.record), created: outcome.created, record: outcome.record };
}

export async function findOrCreate(
  services: ServiceContainer,
  collection: string,
  matchOn: { field: string; value: string },
  createWith: Record<string, unknown>
): Promise<FindOrCreateResult> {
  return executeFindOrCreate(services, await prepareFindOrCreate(services, collection, matchOn, createWith));
}
