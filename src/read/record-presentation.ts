import type { ServiceContainer } from '../tools/init-tool.js';
import type { EntityMetadata, EntityProperty } from '../types/index.js';
import { UnknownCollectionError, UnknownFieldError } from '../utils/errors.js';
import { isGuid } from '../utils/odata.js';
import { resolveFieldPath } from '../utils/filter-compiler.js';

const EMPTY_ID = '00000000-0000-0000-0000-000000000000';
const DEFAULT_FIELDS = [
  'Id',
  'Name',
  'Title',
  'Number',
  'Email',
  'Phone',
  'MobilePhone',
  'CityId',
  'AccountId',
  'OwnerId',
  'StatusId',
  'StageId',
  'TypeId',
  'Amount',
  'ModifiedOn',
];

export async function canonicalCollection(services: ServiceContainer, query: string): Promise<string> {
  const result = await services.metadataManager.resolveCollectionReference(query);
  if (!result.name)
    throw new UnknownCollectionError(query, 'suggestions' in result ? result.suggestions : []);
  return result.name;
}

export async function canonicalField(
  services: ServiceContainer,
  collection: string,
  query: string
): Promise<EntityProperty> {
  const ref = await services.metadataManager.resolveFieldReference(collection, query);
  if (!ref.name) throw new UnknownFieldError(query, collection, 'suggestions' in ref ? ref.suggestions : []);
  const metadata = await services.metadataManager.getEntityMetadata(collection);
  const property = metadata.properties.find((p) => p.name === ref.name);
  if (!property) throw new UnknownFieldError(query, collection, []);
  return property;
}

export async function readSelect(
  services: ServiceContainer,
  collection: string,
  select?: string
): Promise<string> {
  const metadata = await services.metadataManager.getEntityMetadata(collection);
  if (select === '*')
    return metadata.properties
      .filter((p) => !['Edm.Binary', 'Edm.Stream'].includes(p.type))
      .map((p) => p.name)
      .join(',');
  if (select) {
    const fields = await Promise.all(
      select.split(',').map((field) =>
        resolveFieldPath(field.trim(), {
          collection,
          metadataManager: services.metadataManager,
          odataVersion: services.config.odata_version,
        })
      )
    );
    if (fields.some((field) => ['Edm.Binary', 'Edm.Stream'].includes(field.property.type)))
      throw new Error('Бинарные поля читаются через bpm_field_download.');
    return [...new Set(['Id', ...fields.map((field) => field.path)])].join(',');
  }
  const available = new Set(metadata.properties.map((p) => p.name));
  const fields = DEFAULT_FIELDS.filter((name) => available.has(name));
  return (
    fields.length
      ? fields
      : metadata.properties
          .filter((p) => !['Edm.Binary', 'Edm.Stream'].includes(p.type))
          .slice(0, 10)
          .map((p) => p.name)
  ).join(',');
}

export async function readOrder(
  services: ServiceContainer,
  collection: string,
  order?: string
): Promise<string> {
  if (!order) return 'Id asc';
  const items = await Promise.all(
    order.split(',').map(async (part) => {
      const match = part.trim().match(/^(.+?)(?:\s+(asc|desc))?$/i);
      if (!match) throw new Error('Некорректная сортировка');
      const field = await resolveFieldPath(match[1], {
        collection,
        metadataManager: services.metadataManager,
        odataVersion: services.config.odata_version,
      });
      return `${field.path} ${(match[2] ?? 'asc').toLowerCase()}`;
    })
  );
  if (!items.some((item) => /^Id\s/.test(item))) items.push('Id asc');
  return items.join(',');
}

function displayScalar(value: unknown, property?: EntityProperty): string | number | boolean | null {
  if (value === null || value === undefined || value === EMPTY_ID) return null;
  if (property?.type.startsWith('Edm.Date') && typeof value === 'string') {
    const date = new Date(value);
    if (Number.isFinite(date.getTime()) && date.getUTCFullYear() > 1) {
      return `${new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short', timeZone: 'UTC' }).format(date)} UTC`;
    }
    return null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}

export async function presentRecords(
  services: ServiceContainer,
  collection: string,
  records: Array<Record<string, unknown>>,
  resolveReferences = true
): Promise<{
  displayRecords: Array<Record<string, unknown>>;
  fieldLabels: Record<string, string>;
  warnings: string[];
}> {
  const metadata: EntityMetadata = await services.metadataManager.getEntityMetadata(collection);
  const properties = new Map(metadata.properties.map((p) => [p.name, p]));
  const fieldLabels: Record<string, string> = {};
  for (const field of new Set(records.flatMap((r) => Object.keys(r).filter((key) => !key.startsWith('@'))))) {
    const caption = properties.get(field)?.caption ?? field;
    const duplicates = metadata.properties.filter((p) => p.caption === caption).length > 1;
    fieldLabels[field] = duplicates ? `${caption} (${field})` : caption;
  }
  const references = new Map<string, string>();
  const warnings: string[] = [];
  if (resolveReferences) {
    const groups = new Map<string, { property: EntityProperty; ids: Set<string> }>();
    for (const record of records)
      for (const [field, value] of Object.entries(record)) {
        const property = properties.get(field);
        if (
          !property?.isLookup ||
          !property.lookupCollection ||
          typeof value !== 'string' ||
          !isGuid(value) ||
          value === EMPTY_ID
        )
          continue;
        const nameKey = `${field.replace(/Id$/, '')}Name`;
        if (typeof record[nameKey] === 'string') {
          references.set(`${property.lookupCollection}:${value}`, record[nameKey]);
          continue;
        }
        const key = `${property.lookupCollection}:${property.lookupDisplayColumn ?? 'Name'}`;
        const group = groups.get(key) ?? { property, ids: new Set<string>() };
        group.ids.add(value);
        groups.set(key, group);
      }
    for (const { property, ids } of groups.values()) {
      const display = property.lookupDisplayColumn ?? 'Name';
      try {
        const values = [...ids];
        for (let index = 0; index < values.length; index += 50) {
          const chunk = values.slice(index, index + 50);
          const filter = chunk
            .map((id) => (services.config.odata_version === 3 ? `Id eq guid'${id}'` : `Id eq ${id}`))
            .join(' or ');
          const response = await services.odataClient.getRecords<Record<string, unknown>>(
            property.lookupCollection!,
            { $select: `Id,${display}`, $filter: filter, $top: chunk.length, $orderby: 'Id asc' },
            true,
            chunk.length
          );
          for (const row of response.value) {
            if (typeof row.Id === 'string' && typeof row[display] === 'string')
              references.set(`${property.lookupCollection}:${row.Id}`, row[display] as string);
          }
        }
      } catch {
        warnings.push(
          `Названия связанных записей ${property.lookupCollection} недоступны; их UUID сохранены.`
        );
      }
    }
  }
  const displayRecords = records.map((record) => {
    const result: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(record)) {
      if (field.startsWith('@')) continue;
      const property = properties.get(field);
      const label = fieldLabels[field] ?? field;
      const reference =
        property?.lookupCollection && typeof value === 'string'
          ? references.get(`${property.lookupCollection}:${value}`)
          : undefined;
      result[label] = reference ?? displayScalar(value, property);
    }
    return result;
  });
  return { displayRecords, fieldLabels, warnings };
}
