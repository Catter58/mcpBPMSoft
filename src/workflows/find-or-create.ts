/**
 * findOrCreate — generic helper for workflow tools.
 *
 * Looks up a record in `collection` by `matchOn.field` through LookupResolver
 * with fuzzy matching (exact eq, then contains/core). One confident match —
 * returns it. None — creates a new record using `createWith` (lookup-fields
 * are resolved through LookupResolver). Several or unconfident candidates —
 * throws LookupResolutionError with candidates and creates nothing.
 *
 * The collection name is resolved through MetadataManager (caption-aware), and
 * the field name is resolved through resolveFieldReference.
 */

import type { ServiceContainer } from '../tools/init-tool.js';
import { LookupResolutionError, UnknownCollectionError, UnknownFieldError } from '../utils/errors.js';

export interface FindOrCreateResult {
  id: string;
  created: boolean;
  record: Record<string, unknown>;
}

export async function findOrCreate(
  services: ServiceContainer,
  collection: string,
  matchOn: { field: string; value: string },
  createWith: Record<string, unknown>
): Promise<FindOrCreateResult> {
  const collRef = await services.metadataManager.resolveCollectionReference(collection);
  if (collRef.name === null) {
    throw new UnknownCollectionError(collection, collRef.suggestions);
  }
  const resolvedCollection = collRef.name;

  const fieldRef = await services.metadataManager.resolveFieldReference(resolvedCollection, matchOn.field);
  if (fieldRef.name === null) {
    throw new UnknownFieldError(matchOn.field, resolvedCollection, fieldRef.suggestions);
  }
  const resolvedField = fieldRef.name;

  // Нечёткий поиск: «Ромашка» должна находить «ООО «Ромашка»», а не плодить дубль.
  const lookup = await services.lookupResolver.resolve(resolvedCollection, matchOn.value, resolvedField, {
    fuzzy: true,
  });
  if (lookup.resolved && lookup.id) {
    const record = { Id: lookup.id, [resolvedField]: lookup.matchedValue ?? matchOn.value };
    return { id: lookup.id, created: false, record };
  }
  if (lookup.matchCount > 0) {
    // Несколько (или неуверенное) совпадений — не создаём, пусть выберут из кандидатов.
    throw new LookupResolutionError(resolvedField, matchOn.value, lookup.matchCount, lookup.candidates, {
      lookupCollection: resolvedCollection,
      displayColumn: resolvedField,
    });
  }

  const resolved = await services.lookupResolver.resolveDataLookups(resolvedCollection, createWith);
  const created = await services.odataClient.createRecord<Record<string, unknown>>(
    resolvedCollection,
    resolved.data
  );
  const id = String((created as { Id?: unknown; id?: unknown }).Id ?? (created as { id?: unknown }).id ?? '');
  return { id, created: true, record: created };
}
