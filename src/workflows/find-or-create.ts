/**
 * findOrCreate — generic helper for workflow tools.
 *
 * Looks up a record in `collection` by `matchOn.field == matchOn.value`. If a
 * single match is found, returns it. If none — creates a new record using
 * `createWith` (lookup-fields are resolved through LookupResolver). If 2+ —
 * throws BpmApiError(400) so the caller can ask the user to disambiguate.
 *
 * The collection name is resolved through MetadataManager (caption-aware), and
 * the field name is resolved through resolveFieldReference. Values are escaped
 * via escapeODataString — never concatenated raw into $filter.
 */

import type { ServiceContainer } from '../tools/init-tool.js';
import { BpmApiError, UnknownCollectionError, UnknownFieldError } from '../utils/errors.js';
import { escapeODataString } from '../utils/odata.js';

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

  const escaped = escapeODataString(matchOn.value);
  const filter = `${resolvedField} eq '${escaped}'`;

  const response = await services.odataClient.getRecords<Record<string, unknown>>(resolvedCollection, {
    $filter: filter,
    $top: 2,
  });

  const matches = response.value;
  if (matches.length === 1) {
    const record = matches[0];
    const id = String(record.Id ?? record.id ?? '');
    return { id, created: false, record };
  }

  if (matches.length >= 2) {
    throw new BpmApiError(
      `Найдено ${matches.length} совпадений по ${resolvedField}='${matchOn.value}', уточните или используйте bpm_search_records`,
      400,
      resolvedCollection,
      undefined,
      undefined,
      [
        `Уточните значение, чтобы оно было уникальным.`,
        `Или используйте bpm_search_records для поиска нужной записи и передайте UUID напрямую.`,
      ]
    );
  }

  const resolvedData = await services.lookupResolver.resolveDataLookups(resolvedCollection, createWith);
  const created = await services.odataClient.createRecord<Record<string, unknown>>(resolvedCollection, resolvedData);
  const id = String((created as { Id?: unknown; id?: unknown }).Id ?? (created as { id?: unknown }).id ?? '');
  return { id, created: true, record: created };
}
