/**
 * Metadata Manager for BPMSoft OData
 *
 * Fetches and caches entity metadata ($metadata XML), providing information
 * about collections, fields, types, and lookup relationships.
 *
 * Uses fast-xml-parser instead of regex for robust EDMX parsing.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { XMLParser } from 'fast-xml-parser';

import type { BpmConfig, EntityMetadata, EntityProperty, ODataVersion } from '../types/index.js';
import type { ODataCollectionResponse } from '../types/index.js';
import { ODataClient } from '../client/odata-client.js';
import { HttpClient } from '../client/http-client.js';
import { getODataBaseUrl } from '../config.js';
import { isSafeIdentifier, escapeODataString } from '../utils/odata.js';
import { aliasCandidates } from '../utils/ru-aliases.js';

// EDMX type model (subset we care about)
interface EdmxProperty {
  '@_Name'?: string;
  '@_Type'?: string;
  '@_Nullable'?: string;
}

interface EdmxNavigationProperty {
  '@_Name'?: string;
  /** Только v4. */
  '@_Type'?: string;
  /** v3: `NS.AssociationName` + роли концов связи. */
  '@_Relationship'?: string;
  '@_ToRole'?: string;
}

/** v3 CSDL: `<Association><End Type Role Multiplicity/></Association>`. */
interface EdmxAssociation {
  '@_Name'?: string;
  End?: EdmxAssociationEnd | EdmxAssociationEnd[];
}

interface EdmxAssociationEnd {
  '@_Type'?: string;
  '@_Role'?: string;
  '@_Multiplicity'?: string;
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
  /** v3: qualified association name ("NS.Contact_Account") -> Association */
  associations: Map<string, EdmxAssociation>;
}

export class MetadataManager {
  private cache = new Map<string, EntityMetadata>();
  private parsedMetadata: ParsedMetadata | null = null;
  private fullMetadataXml: string | null = null;
  private lastFetchTime = 0;
  private inflightMetadata: Promise<void> | null = null;
  private odataVersion: ODataVersion;
  private captionCache = new Map<string, Map<string, string>>();
  /** Русская подпись объекта → имя EntitySet (null — не нашли). */
  private captionByCollection = new Map<string, string | null>();
  private captionSupported: boolean | null = null;
  private lookupGraph: { source: ParsedMetadata; graph: LookupGraph } | null = null;

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

  /**
   * Граф lookup-связей всех коллекций. Строится один раз на загруженный EDMX
   * и живёт, пока не перезагрузится $metadata (тот же TTL).
   */
  async getLookupGraph(): Promise<LookupGraph> {
    await this.ensureMetadataLoaded();
    const meta = this.parsedMetadata!;
    if (this.lookupGraph?.source !== meta) {
      this.lookupGraph = { source: meta, graph: buildLookupGraph(meta, this.odataVersion) };
    }
    return this.lookupGraph.graph;
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
   *   - { name, autoCorrected } — only with `autoCorrect`: a single unambiguous typo fix
   *   - { suggestions }         — if no match; up to 5 closest names+captions
   *
   * Used by tools to convert business-language field names ("Город", "Дата создания")
   * into OData identifiers ("CityId", "CreatedOn") before sending the request.
   * `autoCorrect` is for READ paths only: a write must never land in a guessed column.
   */
  async resolveFieldReference(
    collection: string,
    query: string,
    options: { autoCorrect?: boolean } = {}
  ): Promise<{ name: string; autoCorrected?: boolean } | { name: null; suggestions: string[] }> {
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

    // 6. Русская подпись из встроенного словаря — спасение для стендов, где
    //    SysEntitySchemaColumn недоступен и caption'ов колонок нет вовсе.
    for (const candidate of aliasCandidates(query)) {
      const hit = metadata.properties.find((p) => p.name === candidate);
      if (hit) return { name: hit.name };
      // Для v4 подпись может указывать на базовое имя lookup'а («Город» → City → CityId).
      if (this.odataVersion === 4 && !candidate.endsWith('Id')) {
        const withId = metadata.properties.find((p) => p.name === `${candidate}Id`);
        if (withId) return { name: withId.name };
      }
      if (this.odataVersion === 3 && candidate.endsWith('Id')) {
        const withoutId = metadata.properties.find((p) => p.name === candidate.slice(0, -2));
        if (withoutId) return { name: withoutId.name };
      }
    }

    const { suggestFields, uniqueClosest } = await import('../utils/suggest.js');

    // 7. Опечатка («Nmae», «Accont») — только на чтении и только при однозначном кандидате.
    if (options.autoCorrect) {
      const hit = uniqueClosest(
        query,
        metadata.properties.map((p) => ({
          value: p.name,
          keys: [p.name, p.isLookup && p.name.endsWith('Id') ? p.name.slice(0, -2) : undefined, p.caption],
        }))
      );
      if (hit) return { name: hit, autoCorrected: true };
    }

    // No match → produce suggestions from {name, caption} pairs
    const suggestions = suggestFields(
      query,
      metadata.properties.map((p) => ({ name: p.name, caption: p.caption }))
    );
    return { name: null, suggestions };
  }

  /**
   * Resolve a (possibly-Russian) collection reference into the canonical EntitySet name.
   * Returns either { name } or { name: null, suggestions: string[] }.
   *
   * `autoCorrected: true` — имя угадано, а не совпало: суффикс `Collection` не той версии
   * OData («ContactCollection» на v4), множественное число подписи («Контакты»), опечатка.
   * Суффикс правится всегда (та же сущность); множественное число и опечатка — только
   * с `autoCorrect` (пути чтения).
   */
  async resolveCollectionReference(
    query: string,
    options: { autoCorrect?: boolean } = {}
  ): Promise<{ name: string; autoCorrected?: boolean } | { name: null; suggestions: string[] }> {
    await this.ensureMetadataLoaded();
    const sets = Array.from(this.parsedMetadata!.entitySets.keys());
    const findSet = (name: string) => {
      const lower = name.toLowerCase();
      return sets.includes(name) ? name : sets.find((s) => s.toLowerCase() === lower);
    };

    if (sets.includes(query)) return { name: query };
    const ci = findSet(query);
    if (ci) return { name: ci };

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
    const key = captions.join('|');
    if (this.captionByCollection.has(key)) return this.captionByCollection.get(key) ?? null;
    if (!this.httpClient) return null;

    const filter = captions.map((c) => `Caption eq '${escapeODataString(c)}'`).join(' or ');
    const url = `${getODataBaseUrl(this.config)}/SysSchema?$filter=${filter}&$select=Name,Caption&$top=${5 * captions.length}`;
    try {
      const response = await this.httpClient.request<
        ODataCollectionResponse<{ Name: string; Caption?: string }>
      >({
        method: 'GET',
        url,
        contentKind: 'crud',
      });
      const rows = (response.data?.value ?? []).filter((row) => typeof row.Name === 'string');
      const lowered = captions.map((c) => c.toLowerCase());
      rows.sort((a, b) => rankOf(lowered, a.Caption) - rankOf(lowered, b.Caption));
      const name = rows[0]?.Name ?? null;
      this.captionByCollection.set(key, name);
      return name;
    } catch {
      this.captionByCollection.set(key, null);
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
    const url = `${getODataBaseUrl(this.config)}/SysSchema?$filter=Name eq '${escaped}' and ExtendParent eq false&$select=UId&$top=1`;
    const response = await this.httpClient.request<ODataCollectionResponse<{ UId: string }>>({
      method: 'GET',
      url,
      contentKind: 'crud',
    });
    return response.data?.value?.[0]?.UId ?? null;
  }

  /**
   * Загружает $metadata не чаще TTL и ровно один раз на «пачку» параллельных
   * вызовов: HTTP-транспорт поднимает McpServer на каждый запрос, поэтому без
   * дедупликации in-flight десятки одновременных tool-вызовов тянут и парсят
   * многомегабайтный EDMX каждый сам по себе.
   */
  private async ensureMetadataLoaded(): Promise<void> {
    const ttlMs = this.config.lookup_cache_ttl * 1000;
    if (this.parsedMetadata && Date.now() - this.lastFetchTime < ttlMs) {
      return;
    }
    if (this.inflightMetadata) return this.inflightMetadata;

    this.inflightMetadata = this.fetchAndParseMetadata().finally(() => {
      this.inflightMetadata = null;
    });
    return this.inflightMetadata;
  }

  private async fetchAndParseMetadata(): Promise<void> {
    const cached = this.readDiskCache();
    const result = await this.odataClient.getMetadataXml({ etag: cached?.etag });

    let xml: string;
    if (result.notModified && cached) {
      console.error('[MetadataManager] $metadata не изменился (304), беру дисковый кэш');
      xml = cached.xml;
    } else {
      xml = result.xml;
      this.writeDiskCache(xml, result.etag);
      console.error(`[MetadataManager] Загружен $metadata: ${Math.round(xml.length / 1024)} КБ`);
    }

    this.fullMetadataXml = xml;
    this.lastFetchTime = Date.now();
    this.parsedMetadata = this.parseMetadataXml(xml);
    this.cache.clear();
    console.error(
      `[MetadataManager] Parsed ${this.parsedMetadata.entitySets.size} entity sets, ${this.parsedMetadata.entityTypes.size} entity types`
    );
  }

  /**
   * Дисковый кэш $metadata. Документ на типовом стенде — 2.5 МБ и несколько
   * секунд загрузки, а меняется он только при доставке пакетов, поэтому храним
   * его между перезапусками процесса и проверяем актуальность через ETag.
   * Отключается `BPMSOFT_METADATA_CACHE=off`, каталог — `BPMSOFT_METADATA_CACHE_DIR`.
   */
  private cacheFileBase(): string | null {
    if ((process.env.BPMSOFT_METADATA_CACHE || '').toLowerCase() === 'off') return null;
    const dir = process.env.BPMSOFT_METADATA_CACHE_DIR || join(tmpdir(), 'mcp-bpmsoft-metadata');
    const key = createHash('sha1')
      .update(`${this.config.bpmsoft_url}|${this.config.odata_version}|${this.config.platform}`)
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
      const xml = readFileSync(`${base}.xml`, 'utf8');
      if (!xml) return null;
      let etag: string | undefined;
      try {
        etag = readFileSync(`${base}.etag`, 'utf8').trim() || undefined;
      } catch {
        etag = undefined;
      }
      return { xml, etag };
    } catch {
      return null;
    }
  }

  private writeDiskCache(xml: string, etag?: string): void {
    const base = this.cacheFileBase();
    if (!base || !xml) return;
    try {
      writeFileSync(`${base}.xml`, xml, 'utf8');
      if (etag) writeFileSync(`${base}.etag`, etag, 'utf8');
    } catch (error) {
      console.error(
        `[MetadataManager] Не удалось сохранить кэш $metadata: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /** Parse EDMX into normalized maps. Pure function over the XML string. */
  parseMetadataXml(xml: string): ParsedMetadata {
    const parsed = this.xmlParser.parse(xml) as EdmxRoot;

    const entitySets = new Map<string, string>();
    const entityTypes = new Map<string, EdmxEntityType>();
    const associations = new Map<string, EdmxAssociation>();

    const dataServices = parsed['edmx:Edmx']?.['edmx:DataServices'];
    if (!dataServices) return { entitySets, entityTypes, associations };

    const schemas = toArray(dataServices.Schema);
    for (const schema of schemas) {
      // EntityTypes
      for (const et of toArray(schema.EntityType)) {
        if (et['@_Name']) entityTypes.set(et['@_Name'], et);
      }
      // Associations (v3): NavigationProperty.Relationship ссылается на них по qualified-имени
      const ns = schema['@_Namespace'];
      for (const assoc of toArray(schema.Association)) {
        if (assoc['@_Name']) associations.set(ns ? `${ns}.${assoc['@_Name']}` : assoc['@_Name'], assoc);
      }
      // EntitySets
      const sets = toArray(schema.EntityContainer?.EntitySet);
      for (const es of sets) {
        const name = es['@_Name'];
        const type = es['@_EntityType'];
        if (name && type) entitySets.set(name, type);
      }
    }

    return { entitySets, entityTypes, associations };
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

        properties.push({
          name,
          type,
          nullable,
          isLookup,
          lookupCollection,
          lookupNavProperty: isLookup ? lookupCollection : undefined,
        });
        if (isLookup) lookupFields.push(name);
      }

      // Pass 2: refine via NavigationProperty
      for (const np of toArray(entityType.NavigationProperty)) {
        const navName = np['@_Name'];
        const navType = np['@_Type'];
        if (!navName || !navType) continue;
        const targetCollection =
          navType
            .replace(/^Collection\(/, '')
            .replace(/\)$/, '')
            .split('.')
            .pop() || navName;
        const fkFieldName = this.odataVersion === 4 ? `${navName}Id` : navName;
        const existing = properties.find((p) => p.name === fkFieldName);
        if (existing) {
          existing.isLookup = true;
          existing.lookupCollection = targetCollection;
          existing.lookupDisplayColumn = 'Name';
          existing.lookupNavProperty = navName;
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
      const columnsResponse = await this.httpClient.request<
        ODataCollectionResponse<{ Name: string; Caption: string }>
      >({
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
        console.error(
          '[MetadataManager] SysSchema/SysEntitySchemaColumn unavailable, trying VwSysEntitySchemaColumn...'
        );
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
      const response = await this.httpClient.request<
        ODataCollectionResponse<{ Name: string; Caption: string }>
      >({
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
    // Стенды без подписей колонок: «Город» находим по встроенному словарю (City/CityId).
    const aliasNames = new Set(aliasCandidates(searchText).flatMap((name) => [name, `${name}Id`]));

    const collectFromMetadata = (metadata: EntityMetadata) => {
      for (const prop of metadata.properties) {
        const caption = prop.caption || '';
        if (
          caption.toLowerCase().includes(lowerSearch) ||
          prop.name.toLowerCase().includes(lowerSearch) ||
          aliasNames.has(prop.name)
        ) {
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
  const setByType = new Map<string, string>();
  for (const [setName, qualifiedType] of meta.entitySets) {
    const short = qualifiedType.split('.').pop();
    if (short && !setByType.has(short)) setByType.set(short, setName);
  }

  const outgoing = new Map<string, LookupEdge[]>();
  const incoming = new Map<string, LookupEdge[]>();
  const displayColumns = new Map<string, string | null>();
  let edgeCount = 0;

  for (const [setName, qualifiedType] of meta.entitySets) {
    const entityType = meta.entityTypes.get(qualifiedType.split('.').pop() || setName);
    if (!entityType || !isSafeIdentifier(setName)) continue;

    const propNames = new Set(toArray(entityType.Property).map((p) => p['@_Name']));
    displayColumns.set(setName, DISPLAY_COLUMN_CANDIDATES.find((c) => propNames.has(c)) ?? null);

    for (const np of toArray(entityType.NavigationProperty)) {
      const nav = np['@_Name'];
      const type = singleNavTarget(meta, np);
      if (!nav || !type || SYSTEM_NAVS.has(nav)) continue;
      const field = `${nav}Id`;
      const to = setByType.get(type.split('.').pop() || '');
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
