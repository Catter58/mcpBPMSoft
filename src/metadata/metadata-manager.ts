/**
 * Metadata Manager for BPMSoft OData
 *
 * Fetches and caches entity metadata ($metadata XML), providing information
 * about collections, fields, types, and lookup relationships.
 *
 * Uses fast-xml-parser instead of regex for robust EDMX parsing.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { XMLParser } from 'fast-xml-parser';

import type {
  BpmConfig,
  EntityMetadata,
  EntityNavigationProperty,
  EntityProperty,
  ODataVersion,
} from '../types/index.js';
import type { ODataCollectionResponse } from '../types/index.js';
import { ODataClient } from '../client/odata-client.js';
import { HttpClient } from '../client/http-client.js';
import { getODataBaseUrl } from '../config.js';
import { aliasCandidates } from '../utils/ru-aliases.js';
import { isSafeIdentifier, escapeODataString } from '../utils/odata.js';
import { BpmApiError, UnknownCollectionError, UnknownFieldError } from '../utils/errors.js';
import { getAuthCacheScope } from '../auth/request-context.js';
import { UUID_RE } from '../utils/field-values.js';

// EDMX type model (subset we care about)
interface EdmxProperty {
  '@_Name'?: string;
  '@_Type'?: string;
  '@_Nullable'?: string;
}

interface EdmxNavigationProperty {
  '@_Name'?: string;
  '@_Type'?: string;
  '@_Relationship'?: string;
  '@_ToRole'?: string;
  '@_Partner'?: string;
  ReferentialConstraint?: { '@_Property'?: string } | Array<{ '@_Property'?: string }>;
}

interface EdmxEntityType {
  '@_Name'?: string;
  Key?: { PropertyRef?: { '@_Name'?: string } | Array<{ '@_Name'?: string }> };
  Property?: EdmxProperty | EdmxProperty[];
  NavigationProperty?: EdmxNavigationProperty | EdmxNavigationProperty[];
}

interface EdmxEntitySet {
  '@_Name'?: string;
  '@_EntityType'?: string;
  NavigationPropertyBinding?:
    | { '@_Path'?: string; '@_Target'?: string }
    | Array<{ '@_Path'?: string; '@_Target'?: string }>;
}

interface EdmxAssociation {
  '@_Name'?: string;
  End?:
    | { '@_Role'?: string; '@_Type'?: string; '@_Multiplicity'?: string }
    | Array<{ '@_Role'?: string; '@_Type'?: string; '@_Multiplicity'?: string }>;
  ReferentialConstraint?: {
    Dependent?: { PropertyRef?: { '@_Name'?: string } | Array<{ '@_Name'?: string }> };
  };
}

interface EdmxSchema {
  '@_Namespace'?: string;
  EntityType?: EdmxEntityType | EdmxEntityType[];
  Association?: EdmxAssociation | EdmxAssociation[];
  EntityContainer?: {
    EntitySet?: EdmxEntitySet | EdmxEntitySet[];
  };
}

interface EdmxRoot {
  ['edmx:Edmx']?: {
    ['edmx:DataServices']?: {
      Schema?: EdmxSchema | EdmxSchema[];
    };
  };
}

interface ParsedMetadata {
  /** entitySetName -> qualified entityType name (e.g. "BPMSoft.Contact") */
  entitySets: Map<string, string>;
  /** short entity type name -> entity type definition */
  entityTypes: Map<string, EdmxEntityType>;
  associations: Map<string, EdmxAssociation>;
  entitySetDefinitions: Map<string, EdmxEntitySet>;
}

interface LocalizedCaption {
  cultureName?: string;
  value?: string;
}
interface DesignerColumn {
  name?: string;
  caption?: LocalizedCaption[] | string;
  requirementType?: number;
  defValue?: { valueSourceType?: number; value?: unknown };
}
interface DesignerSchema {
  columns?: DesignerColumn[];
  inheritedColumns?: DesignerColumn[];
}

export class MetadataManager {
  private cache = new Map<string, EntityMetadata>();
  private documents = new Map<string, { parsed: ParsedMetadata; capturedAt: number }>();
  private captionByCollection = new Map<string, { name: string | null; capturedAt: number }>();
  private lookupGraphs = new WeakMap<ParsedMetadata, LookupGraph>();
  private pendingEntities = new Map<string, { source: ParsedMetadata; promise: Promise<EntityMetadata> }>();
  private pendingDocuments = new Map<string, Promise<ParsedMetadata>>();
  private odataVersion: ODataVersion;
  private captionCache = new Map<string, { values: Map<string, string>; capturedAt: number }>();
  private columnRequirements = new Map<
    string,
    Map<string, Pick<EntityProperty, 'required' | 'requirementSource' | 'defaultHint'>>
  >();

  private readonly xmlParser: XMLParser;

  constructor(
    private config: BpmConfig,
    private odataClient: ODataClient,
    private httpClient?: HttpClient
  ) {
    this.odataVersion = config.odata_version;
    this.xmlParser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      allowBooleanAttributes: true,
      parseAttributeValue: false,
      removeNSPrefix: false,
      isArray: () => false,
      processEntities: false,
    });
  }

  /** Get list of all available entity sets (collections) */
  async getEntitySets(pattern?: string): Promise<Array<{ name: string; entityType: string }>> {
    const parsed = await this.ensureMetadataLoaded();
    const sets = Array.from(parsed.entitySets.entries()).map(([name, type]) => ({
      name,
      entityType: type,
    }));

    if (pattern) {
      const lower = pattern.toLowerCase();
      return sets.filter((s) => s.name.toLowerCase().includes(lower));
    }
    return sets;
  }

  async getLookupGraph(): Promise<LookupGraph> {
    const parsed = await this.ensureMetadataLoaded();
    let graph = this.lookupGraphs.get(parsed);
    if (!graph) {
      graph = buildLookupGraph(parsed, this.odataVersion);
      this.lookupGraphs.set(parsed, graph);
    }
    return graph;
  }

  /** Get metadata for a specific entity (collection) */
  async getEntityMetadata(collection: string): Promise<EntityMetadata> {
    const parsed = await this.ensureMetadataLoaded();
    const resolved = this.canonicalCollection(parsed, collection);
    if (!resolved) throw new UnknownCollectionError(collection, []);
    const cacheKey = `${getAuthCacheScope()}:${resolved}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < this.config.lookup_cache_ttl * 1000) {
      return cached;
    }

    const pending = this.pendingEntities.get(cacheKey);
    if (pending?.source === parsed) return pending.promise;
    const promise = this.parseEntityMetadata(resolved, parsed);
    const entry = { source: parsed, promise };
    this.pendingEntities.set(cacheKey, entry);
    try {
      const metadata = await promise;
      if (this.documents.get(getAuthCacheScope())?.parsed === parsed) {
        if (this.cache.size >= 1000) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(cacheKey, metadata);
      }
      return metadata;
    } finally {
      if (this.pendingEntities.get(cacheKey) === entry) this.pendingEntities.delete(cacheKey);
    }
  }

  async isLookupField(collection: string, fieldName: string): Promise<boolean> {
    const metadata = await this.getEntityMetadata(collection);
    return metadata.lookupFields.includes(fieldName);
  }

  async getLookupInfo(
    collection: string,
    fieldName: string
  ): Promise<{ lookupCollection: string; displayColumn: string; navigationProperty?: string } | null> {
    const metadata = await this.getEntityMetadata(collection);
    const prop = metadata.properties.find((p) => p.name === fieldName);
    if (!prop?.isLookup || !prop.lookupCollection) return null;
    return {
      lookupCollection: prop.lookupCollection,
      displayColumn: prop.lookupDisplayColumn || 'Name',
      navigationProperty: prop.navigationProperty,
    };
  }

  /** A collection navigation is usable only when EDMX resolves it to a published entity set. */
  async getCollectionNavigationInfo(
    collection: string,
    navigationName: string
  ): Promise<EntityNavigationProperty | null> {
    const metadata = await this.getEntityMetadata(collection);
    return (
      metadata.navigationProperties?.find((item) => item.name === navigationName && item.isCollection) ?? null
    );
  }

  getLookupFieldName(baseName: string): string {
    if (this.odataVersion === 4) {
      return baseName.endsWith('Id') ? baseName : `${baseName}Id`;
    }
    return baseName.endsWith('Id') ? baseName.slice(0, -2) : baseName;
  }

  async normalizeFieldName(collection: string, fieldName: string): Promise<string> {
    const ref = await this.resolveFieldReference(collection, fieldName);
    if (ref.name === null) throw new UnknownFieldError(fieldName, collection, ref.suggestions);
    return ref.name;
  }

  /**
   * Resolve a possibly-Russian field reference into the actual OData field name
   * for the current OData version. Returns:
   *   - { name }                — if exact match found
   *   - { suggestions }         — if no match; up to 5 closest names+captions
   *
   * Used by tools to convert business-language field names ("Город", "Дата создания")
   * into OData identifiers ("CityId", "CreatedOn") before sending the request.
   */
  async resolveFieldReference(
    collection: string,
    query: string,
    options: { autoCorrect?: boolean } = {}
  ): Promise<{ name: string; autoCorrected?: boolean } | { name: null; suggestions: string[] }> {
    const metadata = await this.getEntityMetadata(collection);
    query = query.trim();
    const lower = query.toLowerCase();

    // 1. exact match by name
    for (const p of metadata.properties) {
      if (p.name === query) return { name: p.name };
    }
    // 2. case-insensitive name
    const names = metadata.properties.filter((p) => p.name.toLowerCase() === lower);
    if (names.length === 1) return { name: names[0].name };
    // 3. caption (rus.)
    const captions = metadata.properties.filter((p) => p.caption?.trim().toLowerCase() === lower);
    if (captions.length === 1) return { name: captions[0].name };
    if (captions.length > 1 || names.length > 1) {
      const candidates = captions.length > 1 ? captions : names;
      throw new BpmApiError(
        `Поле "${query}" неоднозначно в коллекции ${collection}. Укажите техническое имя поля.`,
        400,
        collection,
        undefined,
        candidates.map((p) => `${p.name}${p.caption ? ` (${p.caption})` : ''}`),
        undefined,
        'validation'
      );
    }
    // 4. v4: try +Id
    if (this.odataVersion === 4 && !query.endsWith('Id')) {
      const withId = `${query}Id`;
      for (const p of metadata.properties) {
        if (p.name === withId) return { name: p.name };
      }
    }
    // 5. v3: try -Id
    if (this.odataVersion === 3 && query.endsWith('Id')) {
      const withoutId = query.slice(0, -2);
      for (const p of metadata.properties) {
        if (p.name === withoutId) return { name: p.name };
      }
    }

    const aliases = new Set<string>();
    for (const candidate of aliasCandidates(query)) {
      const forms = [candidate, this.odataVersion === 4 ? `${candidate}Id` : candidate.replace(/Id$/, '')];
      for (const form of forms)
        if (metadata.properties.some((property) => property.name === form)) aliases.add(form);
    }
    if (aliases.size === 1) return { name: [...aliases][0] };
    if (aliases.size > 1)
      throw new BpmApiError(
        `Поле "${query}" неоднозначно в коллекции ${collection}. Укажите техническое имя.`,
        400,
        collection,
        undefined,
        [...aliases],
        undefined,
        'validation'
      );
    const { suggestFields, uniqueClosest } = await import('../utils/suggest.js');
    if (options.autoCorrect) {
      const hit = uniqueClosest(
        query,
        metadata.properties.map((property) => ({
          value: property.name,
          keys: [
            property.name,
            property.isLookup ? property.name.replace(/Id$/, '') : undefined,
            property.caption,
          ],
        }))
      );
      if (hit) return { name: hit, autoCorrected: true };
    }
    const suggestions = suggestFields(
      query,
      metadata.properties.map((p) => ({ name: p.name, caption: p.caption }))
    );
    return { name: null, suggestions };
  }

  /**
   * Resolve a (possibly-Russian) collection reference into the canonical EntitySet name.
   * Returns either { name } or { name: null, suggestions: string[] }.
   */
  async resolveCollectionReference(
    query: string,
    options: { autoCorrect?: boolean } = {}
  ): Promise<{ name: string; autoCorrected?: boolean } | { name: null; suggestions: string[] }> {
    query = query.trim();
    const parsed = await this.ensureMetadataLoaded();
    const sets = Array.from(parsed.entitySets.keys());
    const findSet = (name: string) => {
      const lower = name.toLowerCase();
      return sets.includes(name) ? name : sets.find((s) => s.toLowerCase() === lower);
    };

    if (sets.includes(query)) return { name: query };
    const ci = findSet(query);
    if (ci) return { name: ci };

    const canonical = this.canonicalCollection(parsed, query);
    if (canonical)
      return {
        name: canonical,
        ...(canonical.toLowerCase() === `${query}Collection`.toLowerCase() ? { autoCorrected: true } : {}),
      };

    // «ContactCollection» на v4 → Contact; «Contact» на v3 → ContactCollection.
    const swapped = /collection$/i.test(query) ? findSet(query.slice(0, -10)) : findSet(`${query}Collection`);
    if (swapped) return { name: swapped, autoCorrected: true };

    // SysSchema знает имя объекта (Contact), EntitySet на v3 — ContactCollection.
    const setForSchema = (schema: string | null) =>
      schema ? (findSet(schema) ?? findSet(`${schema}Collection`)) : undefined;

    // Русское имя объекта («Контакт») — единственный доступный источник подписей
    // сущностей это SysSchema; колонок он не покрывает, но объекты — да.
    const bySchemaCaption = setForSchema(await this.resolveCollectionByCaption([query]));
    if (bySchemaCaption) return { name: bySchemaCaption };

    const { suggest, uniqueClosest } = await import('../utils/suggest.js');
    if (options.autoCorrect) {
      const singulars = singularCaptionCandidates(query);
      const bySingular = singulars.length
        ? setForSchema(await this.resolveCollectionByCaption(singulars))
        : undefined;
      if (bySingular) return { name: bySingular, autoCorrected: true };
      const typo = uniqueClosest(
        query,
        sets.map((s) => ({ value: s, keys: [s, s.replace(/Collection$/, '')] }))
      );
      if (typo) return { name: typo, autoCorrected: true };
    }

    return { name: null, suggestions: suggest(query, sets) };
  }

  /**
   * Имя объекта по русской подписи через SysSchema.Caption; несколько вариантов подписи —
   * одним запросом через `or`, приоритет — по порядку в списке.
   * Недоступность SysSchema не считается ошибкой — просто нет подсказки.
   */
  private async resolveCollectionByCaption(captions: string[]): Promise<string | null> {
    const key = `${getAuthCacheScope()}:${captions.join('|')}`;
    const cached = this.captionByCollection.get(key);
    if (cached && Date.now() - cached.capturedAt < this.config.lookup_cache_ttl * 1000) return cached.name;
    if (!this.httpClient) return null;

    const filter = captions.map((c) => `Caption eq '${escapeODataString(c)}'`).join(' or ');
    const url = `${getODataBaseUrl(this.config)}/${this.odataVersion === 3 ? 'SysSchemaCollection' : 'SysSchema'}?$filter=${filter}&$select=Name,Caption&$top=${5 * captions.length}`;
    try {
      const response = await this.httpClient.request<
        ODataCollectionResponse<{ Name: string; Caption?: string }>
      >({
        method: 'GET',
        url,
        contentKind: 'crud',
      });
      const rows = collectionValues(response.data).filter((row) => typeof row.Name === 'string');
      const lowered = captions.map((c) => c.toLowerCase());
      rows.sort((a, b) => rankOf(lowered, a.Caption) - rankOf(lowered, b.Caption));
      const bestRank = rankOf(lowered, rows[0]?.Caption);
      const names = [
        ...new Set(rows.filter((row) => rankOf(lowered, row.Caption) === bestRank).map((row) => row.Name)),
      ];
      if (names.length > 1)
        throw new BpmApiError(
          `Название коллекции "${captions[0]}" неоднозначно. Укажите техническое имя.`,
          400,
          undefined,
          undefined,
          names,
          undefined,
          'validation'
        );
      const name = names[0] ?? null;
      if (this.captionByCollection.size >= 1000)
        this.captionByCollection.delete(this.captionByCollection.keys().next().value!);
      this.captionByCollection.set(key, { name, capturedAt: Date.now() });
      return name;
    } catch (error) {
      if (error instanceof BpmApiError && error.httpStatus === 400) throw error;
      this.captionByCollection.set(key, { name: null, capturedAt: Date.now() });
      return null;
    }
  }

  /**
   * UId базовой схемы объекта (SysSchema с ExtendParent = false). BPMSoft ссылается
   * на объект по нему, а не по имени — например, SocialMessage.EntitySchemaUId.
   */
  async getEntitySchemaUId(entityName: string): Promise<string | null> {
    if (!this.httpClient) return null;
    const escaped = escapeODataString(entityName);
    const url = `${getODataBaseUrl(this.config)}/${this.odataVersion === 3 ? 'SysSchemaCollection' : 'SysSchema'}?$filter=Name eq '${escaped}' and ExtendParent eq false&$select=UId&$top=1`;
    const response = await this.httpClient.request<ODataCollectionResponse<{ UId: string }>>({
      method: 'GET',
      url,
      contentKind: 'crud',
    });
    return collectionValues(response.data)[0]?.UId ?? null;
  }

  private async ensureMetadataLoaded(): Promise<ParsedMetadata> {
    const scope = getAuthCacheScope();
    const ttlMs = this.config.lookup_cache_ttl * 1000;
    const cached = this.documents.get(scope);
    if (cached && Date.now() - cached.capturedAt < ttlMs) return cached.parsed;
    const pending = this.pendingDocuments.get(scope);
    if (pending) return pending;
    const load = (async () => {
      const disk = this.readDiskCache();
      const result = await this.odataClient.getMetadataXml({ etag: disk?.etag });
      const xml = typeof result === 'string' ? result : result.notModified && disk ? disk.xml : result.xml;
      if (typeof result !== 'string' && !result.notModified) this.writeDiskCache(xml, result.etag);
      const parsed = this.parseMetadataXml(xml);
      if (parsed.entitySets.size === 0)
        throw new BpmApiError('Документ $metadata не содержит коллекций OData.', 502);
      if (this.documents.size >= 20) this.documents.delete(this.documents.keys().next().value!);
      const prefix = `${scope}:`;
      for (const key of this.cache.keys()) if (key.startsWith(prefix)) this.cache.delete(key);
      for (const key of this.captionCache.keys()) if (key.startsWith(prefix)) this.captionCache.delete(key);
      for (const key of this.columnRequirements.keys())
        if (key.startsWith(prefix)) this.columnRequirements.delete(key);
      for (const key of this.captionByCollection.keys())
        if (key.startsWith(prefix)) this.captionByCollection.delete(key);
      this.documents.set(scope, { parsed, capturedAt: Date.now() });
      return parsed;
    })();
    this.pendingDocuments.set(scope, load);
    try {
      return await load;
    } finally {
      this.pendingDocuments.delete(scope);
    }
  }

  private cacheFileBase(): string | null {
    if ((process.env.BPMSOFT_METADATA_CACHE || '').toLowerCase() === 'off') return null;
    const dir = process.env.BPMSOFT_METADATA_CACHE_DIR || join(tmpdir(), 'mcp-bpmsoft-metadata');
    const key = createHash('sha1')
      .update(
        `${this.config.bpmsoft_url}|${this.config.odata_version}|${this.config.platform}|${getAuthCacheScope() || this.config.username || ''}`
      )
      .digest('hex')
      .slice(0, 16);
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      return null;
    }
    return join(dir, key);
  }

  private readDiskCache(): { xml: string; etag?: string } | null {
    const base = this.cacheFileBase();
    if (!base) return null;
    try {
      const value = JSON.parse(readFileSync(`${base}.json`, 'utf8')) as { xml?: unknown; etag?: unknown };
      if (typeof value.xml !== 'string' || !value.xml) return null;
      return { xml: value.xml, etag: typeof value.etag === 'string' ? value.etag : undefined };
    } catch {
      return null;
    }
  }

  private writeDiskCache(xml: string, etag?: string): void {
    const base = this.cacheFileBase();
    if (!base || !xml) return;
    const temporary = `${base}.${randomUUID()}.tmp`;
    try {
      // XML and its validator are one atomic document: concurrent processes cannot mix generations.
      writeFileSync(temporary, JSON.stringify({ xml, etag }), { encoding: 'utf8', mode: 0o600 });
      renameSync(temporary, `${base}.json`);
    } catch (error) {
      console.error(
        `[MetadataManager] Не удалось сохранить кэш $metadata: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  /** Parse EDMX into normalized maps. Pure function over the XML string. */
  parseMetadataXml(xml: string): ParsedMetadata {
    const parsed = this.xmlParser.parse(xml) as EdmxRoot;

    const entitySets = new Map<string, string>();
    const entityTypes = new Map<string, EdmxEntityType>();
    const associations = new Map<string, EdmxAssociation>();
    const entitySetDefinitions = new Map<string, EdmxEntitySet>();

    const dataServices = parsed['edmx:Edmx']?.['edmx:DataServices'];
    if (!dataServices) return { entitySets, entityTypes, associations, entitySetDefinitions };

    const schemas = toArray(dataServices.Schema);
    for (const schema of schemas) {
      // EntityTypes
      for (const et of toArray(schema.EntityType)) {
        if (et['@_Name']) entityTypes.set(`${schema['@_Namespace']}.${et['@_Name']}`, et);
      }
      for (const association of toArray(schema.Association)) {
        if (association['@_Name'])
          associations.set(`${schema['@_Namespace']}.${association['@_Name']}`, association);
      }
      // EntitySets
      const sets = toArray(schema.EntityContainer?.EntitySet);
      for (const es of sets) {
        const name = es['@_Name'];
        const type = es['@_EntityType'];
        if (name && type) {
          entitySets.set(name, type);
          entitySetDefinitions.set(name, es);
        }
      }
    }
    // Preserve short aliases only when the type name has one unambiguous namespace.
    const qualified = Array.from(entityTypes.entries());
    for (const [name, type] of qualified) {
      const short = name.split('.').pop()!;
      if (qualified.filter(([candidate]) => candidate.split('.').pop() === short).length === 1)
        entityTypes.set(short, type);
    }
    return { entitySets, entityTypes, associations, entitySetDefinitions };
  }

  private canonicalCollection(meta: ParsedMetadata, query: string): string | null {
    if (meta.entitySets.has(query)) return query;
    const exactType = Array.from(meta.entitySets).filter(
      ([name, type]) =>
        name.toLowerCase() === query.toLowerCase() ||
        type.split('.').pop()?.toLowerCase() === query.toLowerCase()
    );
    return exactType.length === 1 ? exactType[0][0] : null;
  }

  private async parseEntityMetadata(collection: string, meta: ParsedMetadata): Promise<EntityMetadata> {
    const entityTypeName = meta.entitySets.get(collection);
    const shortTypeName = entityTypeName?.split('.').pop() || collection;
    const entityType = meta.entityTypes.get(entityTypeName || shortTypeName);

    const properties: EntityProperty[] = [];
    const lookupFields: string[] = [];
    const navigationProperties: EntityNavigationProperty[] = [];
    const keyFields = toArray(entityType?.Key?.PropertyRef).flatMap((ref) =>
      ref['@_Name'] ? [ref['@_Name']] : []
    );
    const keyFieldSet = new Set(keyFields);

    if (entityType) {
      // Pass 1: regular properties
      for (const p of toArray(entityType.Property)) {
        const name = p['@_Name'];
        const type = p['@_Type'];
        if (!name || !type) continue;
        // CSDL key declarations are authoritative: key properties are non-nullable,
        // even if a platform omits (or incorrectly emits) Nullable on the Property.
        const nullable = keyFieldSet.has(name) ? false : p['@_Nullable'] !== 'false';

        let isLookup = false;
        let lookupCollection: string | undefined;
        if (type === 'Edm.Guid' && name !== 'Id') {
          if (this.odataVersion === 4 && name.endsWith('Id')) {
            isLookup = true;
            lookupCollection = this.canonicalCollection(meta, name.slice(0, -2)) ?? undefined;
          } else if (this.odataVersion === 3 && !name.endsWith('Id')) {
            isLookup = true;
            lookupCollection = this.canonicalCollection(meta, name) ?? undefined;
          }
          isLookup = !!lookupCollection;
        }

        properties.push({ name, type, nullable, isLookup, lookupCollection });
        if (isLookup) lookupFields.push(name);
      }

      // Pass 2: refine via NavigationProperty
      for (const np of toArray(entityType.NavigationProperty)) {
        const navName = np['@_Name'];
        const association = np['@_Relationship'] ? meta.associations.get(np['@_Relationship']) : undefined;
        const targetEnd = toArray(association?.End).find((end) => end['@_Role'] === np['@_ToRole']);
        const navType = np['@_Type'] || targetEnd?.['@_Type'];
        const isCollection = this.odataVersion === 4 && !!navType?.startsWith('Collection(');
        if (navName && navType && isCollection && isSafeIdentifier(navName)) {
          const targetType = navType.startsWith('Collection(')
            ? /^Collection\((.+)\)$/.exec(navType)?.[1]
            : navType;
          const binding = toArray(meta.entitySetDefinitions.get(collection)?.NavigationPropertyBinding).find(
            (item) => item['@_Path'] === navName
          );
          const targetSets = targetType
            ? Array.from(meta.entitySets).filter(([, type]) => type === targetType)
            : [];
          const boundTarget = binding?.['@_Target'];
          const boundTargetType = boundTarget ? meta.entitySets.get(boundTarget) : undefined;
          const targetCollection =
            boundTarget && boundTargetType === targetType
              ? boundTarget
              : !boundTarget && targetSets.length === 1
                ? targetSets[0][0]
                : undefined;
          if (targetCollection && meta.entitySets.has(targetCollection))
            navigationProperties.push({
              name: navName,
              targetCollection,
              isCollection: true,
              ...(np['@_Partner'] ? { partner: np['@_Partner'] } : {}),
            });
        }
        if (
          !navName ||
          !navType ||
          navType.startsWith('Collection(') ||
          targetEnd?.['@_Multiplicity'] === '*'
        )
          continue;
        const binding = toArray(meta.entitySetDefinitions.get(collection)?.NavigationPropertyBinding).find(
          (b) => b['@_Path'] === navName
        );
        const typeSets = Array.from(meta.entitySets).filter(([, type]) => type === navType);
        const targetCollection =
          binding?.['@_Target'] || (typeSets.length === 1 ? typeSets[0][0] : undefined);
        if (!targetCollection || !meta.entitySets.has(targetCollection)) continue;
        const constrained =
          toArray(np.ReferentialConstraint)[0]?.['@_Property'] ||
          toArray(association?.ReferentialConstraint?.Dependent?.PropertyRef)[0]?.['@_Name'];
        const fkFieldName = constrained || (this.odataVersion === 4 ? `${navName}Id` : navName);
        const existing = properties.find((p) => p.name === fkFieldName);
        if (existing) {
          existing.isLookup = true;
          existing.lookupCollection = targetCollection;
          const targetType = meta.entitySets.get(targetCollection);
          const targetProperties = toArray(meta.entityTypes.get(targetType || '')?.Property);
          existing.lookupDisplayColumn =
            ['Name', 'Title', 'Caption', 'Number'].find((candidate) =>
              targetProperties.some((p) => p['@_Name'] === candidate && p['@_Type'] === 'Edm.String')
            ) || 'Id';
          existing.navigationProperty = navName;
          existing.lookupNavProperty = navName;
          if (!lookupFields.includes(fkFieldName)) lookupFields.push(fkFieldName);
        }
      }
    }
    if (!entityType)
      throw new BpmApiError(
        `Тип коллекции "${collection}" отсутствует в документе $metadata.`,
        502,
        collection
      );

    // Enrich with localized captions
    const captions = await this.fetchColumnCaptions(shortTypeName);
    const requirements = this.columnRequirements.get(`${getAuthCacheScope()}:${shortTypeName}`);
    for (const prop of properties) {
      const baseName = prop.navigationProperty || prop.name.replace(/Id$/, '');
      const caption = captions?.get(prop.name) || (prop.isLookup ? captions?.get(baseName) : undefined);
      if (caption) prop.caption = caption;
      const requirement =
        requirements?.get(prop.name) || (prop.isLookup ? requirements?.get(baseName) : undefined);
      if (requirement) Object.assign(prop, requirement);
    }

    return {
      name: shortTypeName,
      collectionName: collection,
      keyFields,
      properties,
      navigationProperties,
      lookupFields,
      cachedAt: Date.now(),
    };
  }

  // Localized captions (best-effort)
  private async fetchColumnCaptions(entityName: string): Promise<Map<string, string> | null> {
    if (!this.httpClient) return null;
    if (!isSafeIdentifier(entityName)) {
      // Unsafe entityName — bail rather than build a broken filter
      return null;
    }

    const cacheKey = `${getAuthCacheScope()}:${entityName}`;
    const cached = this.captionCache.get(cacheKey);
    if (cached && Date.now() - cached.capturedAt < this.config.lookup_cache_ttl * 1000) return cached.values;
    this.columnRequirements.delete(cacheKey);
    this.captionCache.delete(cacheKey);

    const baseUrl = getODataBaseUrl(this.config);

    try {
      // SysSchema → schemaUId
      const schemaUrl = `${baseUrl}/${this.odataVersion === 3 ? 'SysSchemaCollection' : 'SysSchema'}?$filter=Name eq '${entityName}' and ManagerName eq 'EntitySchemaManager'&$select=UId,Name,Caption&$top=1`;
      const schemaResponse = await this.httpClient.request<
        ODataCollectionResponse<{ UId: string; Name: string; Caption: string }>
      >({
        method: 'GET',
        url: schemaUrl,
        contentKind: 'crud',
      });

      const schemas = collectionValues(schemaResponse.data);
      if (!schemas || schemas.length === 0) {
        return this.fetchCaptionsAlternative(entityName);
      }

      const schemaUId = schemas[0].UId;
      if (!UUID_RE.test(schemaUId)) return this.fetchCaptionsAlternative(entityName);
      const designerCaptions = await this.fetchDesignerCaptions(schemaUId, entityName);
      if (designerCaptions?.size) {
        this.cacheCaptions(cacheKey, designerCaptions);
        return designerCaptions;
      }
      const columnsUrl = `${baseUrl}/${this.odataVersion === 3 ? 'SysEntitySchemaColumnCollection' : 'SysEntitySchemaColumn'}?$filter=SysEntitySchemaUId eq ${this.formatGuid(schemaUId)}&$select=Name,Caption&$top=500`;
      const columnsResponse = await this.httpClient.request<
        ODataCollectionResponse<{ Name: string; Caption: string }>
      >({
        method: 'GET',
        url: columnsUrl,
        contentKind: 'crud',
      });

      const columns = collectionValues(columnsResponse.data);
      if (!columns || columns.length === 0) return null;

      const captionMap = new Map<string, string>();
      for (const col of columns) {
        if (col.Name && col.Caption) captionMap.set(col.Name, col.Caption);
      }
      this.cacheCaptions(cacheKey, captionMap);
      console.error(`[MetadataManager] Loaded ${captionMap.size} captions for "${entityName}"`);
      return captionMap;
    } catch (error) {
      // Lack of permission says nothing about platform capability.
      const status = (error as { httpStatus?: number }).httpStatus;
      if (status === 401 || status === 403) return null;
      return this.fetchCaptionsAlternative(entityName);
    }
  }

  private async fetchDesignerCaptions(
    schemaUId: string,
    entityName: string
  ): Promise<Map<string, string> | null> {
    if (!this.httpClient) return null;
    const paths =
      this.config.platform === 'netframework' ? ['/0/ServiceModel', '/ServiceModel'] : ['/ServiceModel'];
    for (const path of paths) {
      try {
        const response = await this.httpClient.request<{ schema?: DesignerSchema }>({
          method: 'POST',
          url: `${this.config.bpmsoft_url}${path}/EntitySchemaDesignerService.svc/GetSchema`,
          body: { schemaUId },
          contentKind: 'crud',
          operation: 'read',
        });
        const schema = response.data?.schema;
        if (!schema) return null;
        const captions = new Map<string, string>();
        const requirements = new Map<
          string,
          Pick<EntityProperty, 'required' | 'requirementSource' | 'defaultHint'>
        >();
        // Own columns override inherited captions in the server's schema descriptor.
        for (const column of [...(schema.inheritedColumns ?? []), ...(schema.columns ?? [])]) {
          if (!column.name || !isSafeIdentifier(column.name)) continue;
          const localized = column.caption;
          const caption =
            typeof localized === 'string'
              ? localized
              : localized?.find((item) => item.cultureName?.toLowerCase() === 'ru-ru')?.value ||
                localized?.find((item) => item.cultureName?.toLowerCase().startsWith('ru'))?.value ||
                localized?.find((item) => typeof item.value === 'string' && item.value.trim())?.value;
          if (typeof caption === 'string' && caption.trim()) captions.set(column.name, caption.trim());
          const type = column.requirementType;
          if (type === 0 || type === 1 || type === 2)
            requirements.set(column.name, {
              required: type !== 0,
              requirementSource: 'entity_schema_designer',
              defaultHint: describeDefault(column.defValue),
            });
        }
        if (this.columnRequirements.size >= 1000)
          this.columnRequirements.delete(this.columnRequirements.keys().next().value!);
        this.columnRequirements.set(`${getAuthCacheScope()}:${entityName}`, requirements);
        return captions.size ? captions : null;
      } catch (error) {
        const status = (error as { httpStatus?: number }).httpStatus;
        if (status === 401 || status === 403) return null;
        if (status !== 404 && status !== 405 && status !== 501) return null;
      }
    }
    return null;
  }

  private async fetchCaptionsAlternative(entityName: string): Promise<Map<string, string> | null> {
    if (!this.httpClient) return null;
    if (!isSafeIdentifier(entityName)) return null;
    const baseUrl = getODataBaseUrl(this.config);

    try {
      const url = `${baseUrl}/${this.odataVersion === 3 ? 'VwSysEntitySchemaColumnCollection' : 'VwSysEntitySchemaColumn'}?$filter=EntitySchemaName eq '${entityName}'&$select=Name,Caption&$top=500`;
      const response = await this.httpClient.request<
        ODataCollectionResponse<{ Name: string; Caption: string }>
      >({
        method: 'GET',
        url,
        contentKind: 'crud',
      });

      const columns = collectionValues(response.data);
      if (!columns || columns.length === 0) {
        return null;
      }

      const captionMap = new Map<string, string>();
      for (const col of columns) {
        if (col.Name && col.Caption) captionMap.set(col.Name, col.Caption);
      }
      this.cacheCaptions(`${getAuthCacheScope()}:${entityName}`, captionMap);
      console.error(
        `[MetadataManager] Loaded ${captionMap.size} captions via VwSysEntitySchemaColumn for "${entityName}"`
      );
      return captionMap;
    } catch {
      return null;
    }
  }

  private cacheCaptions(key: string, values: Map<string, string>): void {
    if (this.captionCache.size >= 1000) this.captionCache.delete(this.captionCache.keys().next().value!);
    this.captionCache.set(key, { values, capturedAt: Date.now() });
  }

  private formatGuid(guid: string): string {
    return this.odataVersion === 3 ? `guid'${guid}'` : `${guid}`;
  }

  /**
   * Search for a field by localized caption (Russian name) across one or all collections.
   */
  async findFieldByCaption(
    searchText: string,
    collection?: string
  ): Promise<
    Array<{ collection: string; fieldName: string; caption: string; type: string; isLookup: boolean }>
  > {
    const results: Array<{
      collection: string;
      fieldName: string;
      caption: string;
      type: string;
      isLookup: boolean;
    }> = [];
    const lowerSearch = searchText.toLowerCase();

    const collectFromMetadata = (metadata: EntityMetadata) => {
      for (const prop of metadata.properties) {
        const caption = prop.caption || '';
        if (caption.toLowerCase().includes(lowerSearch) || prop.name.toLowerCase().includes(lowerSearch)) {
          results.push({
            collection: metadata.collectionName,
            fieldName: prop.name,
            caption,
            type: prop.type,
            isLookup: prop.isLookup,
          });
        }
      }
    };

    if (collection) {
      const metadata = await this.getEntityMetadata(collection);
      collectFromMetadata(metadata);
    } else {
      const scope = `${getAuthCacheScope()}:`;
      for (const [key, metadata] of this.cache) {
        if (key.startsWith(scope) && Date.now() - metadata.cachedAt < this.config.lookup_cache_ttl * 1000)
          collectFromMetadata(metadata);
      }
    }

    return results;
  }
}

/** Одна lookup-связь: у `from` есть FK-колонка `field` (навигация `nav`) на `to`. */
export interface LookupEdge {
  from: string;
  field: string;
  nav: string;
  to: string;
}

/** Все lookup-связи схемы, ключи — имена EntitySet. */
export interface LookupGraph {
  outgoing: Map<string, LookupEdge[]>;
  incoming: Map<string, LookupEdge[]>;
  /** Колонка отображения коллекции (Name/Title/...), null — не нашлась. */
  displayColumns: Map<string, string | null>;
  edgeCount: number;
  /** Версия OData, по которой построен граф: v3-коллекции называются `XxxCollection`. */
  odataVersion: ODataVersion;
}

/** Навигации аудита — есть почти у каждой сущности и связывают всё со всем через Contact. */
const SYSTEM_NAVS = new Set(['CreatedBy', 'ModifiedBy', 'LockedBy']);

/** Тот же порядок, что у getDisplayColumn в utils/display.ts. */
const DISPLAY_COLUMN_CANDIDATES = [
  'Name',
  'Title',
  'LeadName',
  'Subject',
  'Caption',
  'FullName',
  'Code',
  'Number',
];

/**
 * Строит граф lookup-связей за один проход по разобранному EDMX (без запросов
 * подписей). Берутся только одиночные навигации с FK-колонкой `CityId`; коллекционные
 * `XxxCollectionByYyy` — обратные стороны тех же связей.
 * v4: цель — `Type="NS.City"`, `Collection(...)` — коллекционная навигация.
 * v3 (CSDL 2.0): у навигации нет Type — цель и кратность берутся из конца Association
 * с `Role = ToRole`; одиночная, если Multiplicity `0..1` или `1`.
 * ponytail: коллекция по типу цели берётся из EntitySet, а не из AssociationSet — если
 * один тип выставлен в нескольких EntitySet, связь уйдёт в первый.
 */
function buildLookupGraph(meta: ParsedMetadata, odataVersion: ODataVersion): LookupGraph {
  const setByType = new Map<string, string[]>();
  for (const [setName, qualifiedType] of meta.entitySets) {
    const sets = setByType.get(qualifiedType) ?? [];
    sets.push(setName);
    setByType.set(qualifiedType, sets);
  }

  const outgoing = new Map<string, LookupEdge[]>();
  const incoming = new Map<string, LookupEdge[]>();
  const displayColumns = new Map<string, string | null>();
  let edgeCount = 0;

  for (const [setName, qualifiedType] of meta.entitySets) {
    const entityType = meta.entityTypes.get(qualifiedType);
    if (!entityType || !isSafeIdentifier(setName)) continue;

    const propNames = new Set(toArray(entityType.Property).map((p) => p['@_Name']));
    displayColumns.set(setName, DISPLAY_COLUMN_CANDIDATES.find((c) => propNames.has(c)) ?? null);

    for (const np of toArray(entityType.NavigationProperty)) {
      const nav = np['@_Name'];
      const type = singleNavTarget(meta, np);
      if (!nav || !type || SYSTEM_NAVS.has(nav)) continue;
      const association = np['@_Relationship'] ? meta.associations.get(np['@_Relationship']) : undefined;
      const constrained =
        toArray(np.ReferentialConstraint)[0]?.['@_Property'] ||
        toArray(association?.ReferentialConstraint?.Dependent?.PropertyRef)[0]?.['@_Name'];
      const field = constrained || (propNames.has(`${nav}Id`) ? `${nav}Id` : nav);
      const bound = toArray(meta.entitySetDefinitions.get(setName)?.NavigationPropertyBinding).find(
        (binding) => binding['@_Path'] === nav
      )?.['@_Target'];
      const sets = setByType.get(type) ?? [];
      const to = bound || (sets.length === 1 ? sets[0] : undefined);
      if (!to || !propNames.has(field) || !isSafeIdentifier(field) || !isSafeIdentifier(to)) continue;

      const edge: LookupEdge = { from: setName, field, nav, to };
      (outgoing.get(setName) ?? outgoing.set(setName, []).get(setName)!).push(edge);
      (incoming.get(to) ?? incoming.set(to, []).get(to)!).push(edge);
      edgeCount++;
    }
  }

  return { outgoing, incoming, displayColumns, edgeCount, odataVersion };
}

/** Qualified-тип цели одиночной навигации; null — коллекционная или неразрешимая. */
function singleNavTarget(meta: ParsedMetadata, np: EdmxNavigationProperty): string | null {
  const type = np['@_Type'];
  if (type) return type.startsWith('Collection(') ? null : type;

  const relationship = np['@_Relationship'];
  const toRole = np['@_ToRole'];
  if (!relationship || !toRole) return null;
  const end = toArray(meta.associations.get(relationship)?.End).find((e) => e['@_Role'] === toRole);
  const multiplicity = end?.['@_Multiplicity'];
  return multiplicity === '0..1' || multiplicity === '1' ? (end?.['@_Type'] ?? null) : null;
}

/** Позиция подписи в списке вариантов; неизвестная — в конец. */
function rankOf(lowered: string[], caption: string | undefined): number {
  const i = caption ? lowered.indexOf(caption.toLowerCase()) : -1;
  return i === -1 ? lowered.length : i;
}

/**
 * Единственное число русской подписи во множественном: «Контакты» → «Контакт»,
 * «Задачи» → «Задача», «Активности» → «Активность», «Счета» → «Счет».
 * ponytail: эвристика окончаний без морфологии — беглые гласные («Звонки» → «Звонок») не ловит.
 */
export function singularCaptionCandidates(caption: string): string[] {
  const word = caption.trim();
  if (!/[а-яё]$/i.test(word) || word.length < 4) return [];
  const stem = word.slice(0, -1);
  const last = word.slice(-1).toLowerCase();
  if (last === 'ы') return [stem, `${stem}а`];
  if (last === 'и') return [`${stem}а`, `${stem}я`, `${stem}ь`, stem, `${stem}й`];
  if (last === 'а' || last === 'я') return [stem];
  return [];
}

function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function collectionValues<T>(payload: ODataCollectionResponse<T>): T[] {
  if (Array.isArray(payload?.value)) return payload.value;
  const legacy = payload as unknown as { d?: { results?: T[] } | T[]; results?: T[] };
  if (Array.isArray(legacy?.d)) return legacy.d;
  if (legacy?.d && 'results' in legacy.d && Array.isArray(legacy.d.results)) return legacy.d.results;
  return Array.isArray(legacy?.results) ? legacy.results : [];
}

function describeDefault(value: DesignerColumn['defValue']): EntityProperty['defaultHint'] {
  const source = value?.valueSourceType;
  if (source === 0) return { source: 'none', providedByServer: false };
  if (source === 1) {
    const literal = value?.value;
    if (literal === null || literal === undefined) return { source: 'constant', providedByServer: false };
    if (typeof literal === 'string' || typeof literal === 'number' || typeof literal === 'boolean')
      return { source: 'constant', providedByServer: true, value: literal };
    return { source: 'constant' };
  }
  if (source === 2) return { source: 'system_setting', providedByServer: true };
  if (source === 3) return { source: 'runtime', providedByServer: true };
  return { source: 'unknown' };
}
