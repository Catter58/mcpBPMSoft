/**
 * Metadata Manager for BPMSoft OData
 *
 * Fetches and caches entity metadata ($metadata XML), providing information
 * about collections, fields, types, and lookup relationships.
 *
 * Uses fast-xml-parser instead of regex for robust EDMX parsing.
 */

import { XMLParser } from 'fast-xml-parser';

import type {
  BpmConfig,
  EntityMetadata,
  EntityProperty,
  ODataVersion,
} from '../types/index.js';
import type { ODataCollectionResponse } from '../types/index.js';
import { ODataClient } from '../client/odata-client.js';
import { HttpClient } from '../client/http-client.js';
import { getODataBaseUrl } from '../config.js';
import { isSafeIdentifier } from '../utils/odata.js';

// EDMX type model (subset we care about)
interface EdmxProperty {
  '@_Name'?: string;
  '@_Type'?: string;
  '@_Nullable'?: string;
}

interface EdmxNavigationProperty {
  '@_Name'?: string;
  '@_Type'?: string;
}

interface EdmxEntityType {
  '@_Name'?: string;
  Property?: EdmxProperty | EdmxProperty[];
  NavigationProperty?: EdmxNavigationProperty | EdmxNavigationProperty[];
}

interface EdmxEntitySet {
  '@_Name'?: string;
  '@_EntityType'?: string;
}

interface EdmxSchema {
  '@_Namespace'?: string;
  EntityType?: EdmxEntityType | EdmxEntityType[];
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
}

export class MetadataManager {
  private cache = new Map<string, EntityMetadata>();
  private parsedMetadata: ParsedMetadata | null = null;
  private fullMetadataXml: string | null = null;
  private lastFetchTime = 0;
  private odataVersion: ODataVersion;
  private captionCache = new Map<string, Map<string, string>>();
  private captionSupported: boolean | null = null;

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
    });
  }

  /** Get list of all available entity sets (collections) */
  async getEntitySets(pattern?: string): Promise<Array<{ name: string; entityType: string }>> {
    await this.ensureMetadataLoaded();
    const sets = Array.from(this.parsedMetadata!.entitySets.entries()).map(([name, type]) => ({
      name,
      entityType: type,
    }));

    if (pattern) {
      const lower = pattern.toLowerCase();
      return sets.filter((s) => s.name.toLowerCase().includes(lower));
    }
    return sets;
  }

  /** Get metadata for a specific entity (collection) */
  async getEntityMetadata(collection: string): Promise<EntityMetadata> {
    const cached = this.cache.get(collection);
    if (cached && Date.now() - cached.cachedAt < this.config.lookup_cache_ttl * 1000) {
      return cached;
    }

    await this.ensureMetadataLoaded();
    const metadata = await this.parseEntityMetadata(collection);
    this.cache.set(collection, metadata);
    return metadata;
  }

  async isLookupField(collection: string, fieldName: string): Promise<boolean> {
    const metadata = await this.getEntityMetadata(collection);
    return metadata.lookupFields.includes(fieldName);
  }

  async getLookupInfo(
    collection: string,
    fieldName: string
  ): Promise<{ lookupCollection: string; displayColumn: string } | null> {
    const metadata = await this.getEntityMetadata(collection);
    const prop = metadata.properties.find((p) => p.name === fieldName);
    if (!prop?.isLookup || !prop.lookupCollection) return null;
    return {
      lookupCollection: prop.lookupCollection,
      displayColumn: prop.lookupDisplayColumn || 'Name',
    };
  }

  getLookupFieldName(baseName: string): string {
    if (this.odataVersion === 4) {
      return baseName.endsWith('Id') ? baseName : `${baseName}Id`;
    }
    return baseName.endsWith('Id') ? baseName.slice(0, -2) : baseName;
  }

  async normalizeFieldName(collection: string, fieldName: string): Promise<string> {
    const metadata = await this.getEntityMetadata(collection);
    if (metadata.properties.some((p) => p.name === fieldName)) return fieldName;

    // Caption-based match (case-insensitive)
    const captionMatch = metadata.properties.find(
      (p) => p.caption && p.caption.toLowerCase() === fieldName.toLowerCase()
    );
    if (captionMatch) return captionMatch.name;

    // Caption→Id form: e.g. caption "Город" → "City" → "CityId"
    if (this.odataVersion === 4 && captionMatch === undefined) {
      const baseCaption = metadata.properties.find(
        (p) => p.caption && p.caption.toLowerCase() === fieldName.toLowerCase() && p.name + 'Id' in {}
      );
      if (baseCaption) return `${baseCaption.name}Id`;
    }

    if (this.odataVersion === 4 && !fieldName.endsWith('Id')) {
      const withId = `${fieldName}Id`;
      if (metadata.properties.some((p) => p.name === withId)) return withId;
    }
    if (this.odataVersion === 3 && fieldName.endsWith('Id')) {
      const withoutId = fieldName.slice(0, -2);
      if (metadata.properties.some((p) => p.name === withoutId)) return withoutId;
    }
    return fieldName;
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
    query: string
  ): Promise<{ name: string } | { name: null; suggestions: string[] }> {
    const metadata = await this.getEntityMetadata(collection);
    const lower = query.toLowerCase();

    // 1. exact match by name
    for (const p of metadata.properties) {
      if (p.name === query) return { name: p.name };
    }
    // 2. case-insensitive name
    for (const p of metadata.properties) {
      if (p.name.toLowerCase() === lower) return { name: p.name };
    }
    // 3. caption (rus.)
    for (const p of metadata.properties) {
      if (p.caption && p.caption.toLowerCase() === lower) return { name: p.name };
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

    // No match → produce suggestions from {name, caption} pairs
    const { suggestFields } = await import('../utils/suggest.js');
    const suggestions = suggestFields(query, metadata.properties.map((p) => ({ name: p.name, caption: p.caption })));
    return { name: null, suggestions };
  }

  /**
   * Resolve a (possibly-Russian) collection reference into the canonical EntitySet name.
   * Returns either { name } or { name: null, suggestions: string[] }.
   */
  async resolveCollectionReference(query: string): Promise<{ name: string } | { name: null; suggestions: string[] }> {
    await this.ensureMetadataLoaded();
    const sets = Array.from(this.parsedMetadata!.entitySets.keys());

    if (sets.includes(query)) return { name: query };
    const lower = query.toLowerCase();
    const ci = sets.find((s) => s.toLowerCase() === lower);
    if (ci) return { name: ci };

    const { suggest } = await import('../utils/suggest.js');
    return { name: null, suggestions: suggest(query, sets) };
  }

  private async ensureMetadataLoaded(): Promise<void> {
    const ttlMs = this.config.lookup_cache_ttl * 1000;
    if (this.parsedMetadata && Date.now() - this.lastFetchTime < ttlMs) {
      return;
    }

    console.error('[MetadataManager] Fetching $metadata...');
    this.fullMetadataXml = await this.odataClient.getMetadataXml();
    this.lastFetchTime = Date.now();
    this.parsedMetadata = this.parseMetadataXml(this.fullMetadataXml);
    console.error(
      `[MetadataManager] Parsed ${this.parsedMetadata.entitySets.size} entity sets, ${this.parsedMetadata.entityTypes.size} entity types`
    );
  }

  /** Parse EDMX into normalized maps. Pure function over the XML string. */
  parseMetadataXml(xml: string): ParsedMetadata {
    const parsed = this.xmlParser.parse(xml) as EdmxRoot;

    const entitySets = new Map<string, string>();
    const entityTypes = new Map<string, EdmxEntityType>();

    const dataServices = parsed['edmx:Edmx']?.['edmx:DataServices'];
    if (!dataServices) return { entitySets, entityTypes };

    const schemas = toArray(dataServices.Schema);
    for (const schema of schemas) {
      // EntityTypes
      for (const et of toArray(schema.EntityType)) {
        if (et['@_Name']) entityTypes.set(et['@_Name'], et);
      }
      // EntitySets
      const sets = toArray(schema.EntityContainer?.EntitySet);
      for (const es of sets) {
        const name = es['@_Name'];
        const type = es['@_EntityType'];
        if (name && type) entitySets.set(name, type);
      }
    }

    return { entitySets, entityTypes };
  }

  private async parseEntityMetadata(collection: string): Promise<EntityMetadata> {
    const meta = this.parsedMetadata!;
    const entityTypeName = meta.entitySets.get(collection);
    const shortTypeName = entityTypeName?.split('.').pop() || collection;
    const entityType = meta.entityTypes.get(shortTypeName);

    const properties: EntityProperty[] = [];
    const lookupFields: string[] = [];

    if (entityType) {
      // Pass 1: regular properties
      for (const p of toArray(entityType.Property)) {
        const name = p['@_Name'];
        const type = p['@_Type'];
        if (!name || !type) continue;
        const nullable = p['@_Nullable'] !== 'false';

        let isLookup = false;
        let lookupCollection: string | undefined;
        if (type.includes('Guid') && name !== 'Id') {
          if (this.odataVersion === 4 && name.endsWith('Id')) {
            isLookup = true;
            lookupCollection = name.slice(0, -2);
          } else if (this.odataVersion === 3 && !name.endsWith('Id')) {
            isLookup = true;
            lookupCollection = name;
          }
        }

        properties.push({ name, type, nullable, isLookup, lookupCollection });
        if (isLookup) lookupFields.push(name);
      }

      // Pass 2: refine via NavigationProperty
      for (const np of toArray(entityType.NavigationProperty)) {
        const navName = np['@_Name'];
        const navType = np['@_Type'];
        if (!navName || !navType) continue;
        const targetCollection = navType.replace(/^Collection\(/, '').replace(/\)$/, '').split('.').pop() || navName;
        const fkFieldName = this.odataVersion === 4 ? `${navName}Id` : navName;
        const existing = properties.find((p) => p.name === fkFieldName);
        if (existing) {
          existing.isLookup = true;
          existing.lookupCollection = targetCollection;
          existing.lookupDisplayColumn = 'Name';
          if (!lookupFields.includes(fkFieldName)) lookupFields.push(fkFieldName);
        }
      }
    }

    // Enrich with localized captions
    const captions = await this.fetchColumnCaptions(shortTypeName);
    if (captions) {
      for (const prop of properties) {
        const caption = captions.get(prop.name);
        if (caption) prop.caption = caption;
      }
    }

    return {
      name: shortTypeName,
      collectionName: collection,
      properties,
      lookupFields,
      cachedAt: Date.now(),
    };
  }

  // Localized captions (best-effort)
  private async fetchColumnCaptions(entityName: string): Promise<Map<string, string> | null> {
    if (this.captionSupported === false) return null;
    if (!this.httpClient) return null;
    if (!isSafeIdentifier(entityName)) {
      // Unsafe entityName — bail rather than build a broken filter
      return null;
    }

    const cached = this.captionCache.get(entityName);
    if (cached) return cached;

    const baseUrl = getODataBaseUrl(this.config);

    try {
      // SysSchema → schemaUId
      const schemaUrl = `${baseUrl}/SysSchema?$filter=Name eq '${entityName}'&$select=UId,Name,Caption&$top=1`;
      const schemaResponse = await this.httpClient.request<
        ODataCollectionResponse<{ UId: string; Name: string; Caption: string }>
      >({
        method: 'GET',
        url: schemaUrl,
        contentKind: 'crud',
      });

      const schemas = schemaResponse.data?.value;
      if (!schemas || schemas.length === 0) {
        return this.fetchCaptionsAlternative(entityName);
      }

      const schemaUId = schemas[0].UId;
      const columnsUrl = `${baseUrl}/SysEntitySchemaColumn?$filter=SysEntitySchemaUId eq ${this.formatGuid(schemaUId)}&$select=Name,Caption&$top=500`;
      const columnsResponse = await this.httpClient.request<ODataCollectionResponse<{ Name: string; Caption: string }>>({
        method: 'GET',
        url: columnsUrl,
        contentKind: 'crud',
      });

      const columns = columnsResponse.data?.value;
      if (!columns || columns.length === 0) return null;

      const captionMap = new Map<string, string>();
      for (const col of columns) {
        if (col.Name && col.Caption) captionMap.set(col.Name, col.Caption);
      }
      this.captionSupported = true;
      this.captionCache.set(entityName, captionMap);
      console.error(`[MetadataManager] Loaded ${captionMap.size} captions for "${entityName}"`);
      return captionMap;
    } catch {
      if (this.captionSupported === null) {
        console.error('[MetadataManager] SysSchema/SysEntitySchemaColumn unavailable, trying VwSysEntitySchemaColumn...');
        return this.fetchCaptionsAlternative(entityName);
      }
      return null;
    }
  }

  private async fetchCaptionsAlternative(entityName: string): Promise<Map<string, string> | null> {
    if (!this.httpClient) return null;
    if (!isSafeIdentifier(entityName)) return null;
    const baseUrl = getODataBaseUrl(this.config);

    try {
      const url = `${baseUrl}/VwSysEntitySchemaColumn?$filter=EntitySchemaName eq '${entityName}'&$select=Name,Caption&$top=500`;
      const response = await this.httpClient.request<ODataCollectionResponse<{ Name: string; Caption: string }>>({
        method: 'GET',
        url,
        contentKind: 'crud',
      });

      const columns = response.data?.value;
      if (!columns || columns.length === 0) {
        this.captionSupported = false;
        console.error('[MetadataManager] Caption fetching not available on this instance');
        return null;
      }

      const captionMap = new Map<string, string>();
      for (const col of columns) {
        if (col.Name && col.Caption) captionMap.set(col.Name, col.Caption);
      }
      this.captionSupported = true;
      this.captionCache.set(entityName, captionMap);
      console.error(
        `[MetadataManager] Loaded ${captionMap.size} captions via VwSysEntitySchemaColumn for "${entityName}"`
      );
      return captionMap;
    } catch {
      this.captionSupported = false;
      console.error('[MetadataManager] Caption fetching not available on this instance');
      return null;
    }
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
  ): Promise<Array<{ collection: string; fieldName: string; caption: string; type: string; isLookup: boolean }>> {
    const results: Array<{ collection: string; fieldName: string; caption: string; type: string; isLookup: boolean }> = [];
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
      for (const [, metadata] of this.cache) collectFromMetadata(metadata);
    }

    return results;
  }
}

function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}
