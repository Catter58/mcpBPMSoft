import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { MetadataManager } from '../../src/metadata/metadata-manager.js';
import type { BpmConfig } from '../../src/types/index.js';
import { SIMPLE_EDMX } from '../setup/fixtures/edmx.js';
import { runWithAuth, extractAuthFromHeaders } from '../../src/auth/request-context.js';

function makeCfg(): BpmConfig {
  return {
    bpmsoft_url: 'https://bpm.test',
    username: 'u',
    password: 'p',
    odata_version: 4,
    platform: 'net8',
    page_size: 100,
    max_batch_size: 100,
    lookup_cache_ttl: 300,
    request_timeout: 30000,
    max_file_size: 10 * 1024 * 1024,
  };
}

describe('MetadataManager.parseMetadataXml', () => {
  it('parses entitySets and entityTypes from a small EDMX fixture', () => {
    // The parser is a pure function — we can pass `as any` for the heavy deps
    // since we never call methods that touch them in this test.
    const mgr = new MetadataManager(makeCfg(), {} as never, {} as never);
    const parsed = mgr.parseMetadataXml(SIMPLE_EDMX);

    expect(parsed.entitySets.size).toBe(2);
    expect(parsed.entitySets.get('Contact')).toBe('BPMSoft.Contact');
    expect(parsed.entitySets.get('City')).toBe('BPMSoft.City');

    expect(parsed.entityTypes.has('Contact')).toBe(true);
    expect(parsed.entityTypes.has('City')).toBe(true);

    const contact = parsed.entityTypes.get('Contact');
    expect(contact).toBeDefined();
    // NavigationProperty "City" must be present so v4 lookup detection picks up CityId
    const navs = contact?.NavigationProperty;
    const navArr = Array.isArray(navs) ? navs : navs ? [navs] : [];
    expect(navArr.find((n) => n['@_Name'] === 'City')).toBeDefined();
  });

  it('returns empty maps when EDMX has no DataServices', () => {
    const mgr = new MetadataManager(makeCfg(), {} as never, {} as never);
    const parsed = mgr.parseMetadataXml('<root/>');
    expect(parsed.entitySets.size).toBe(0);
    expect(parsed.entityTypes.size).toBe(0);
  });
});

describe('MetadataManager conditional disk cache', () => {
  it('keeps each environment principal separate and binds the validator to its XML', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'bpm-metadata-cache-test-'));
    const prior = process.env.BPMSOFT_METADATA_CACHE_DIR;
    process.env.BPMSOFT_METADATA_CACHE_DIR = directory;
    const requests: Array<{ etag?: string }> = [];
    const client = {
      async getMetadataXml(options: { etag?: string }) {
        requests.push(options);
        return options.etag
          ? { xml: '', etag: options.etag, notModified: true }
          : { xml: SIMPLE_EDMX, etag: '"generation-one"', notModified: false };
      },
    };
    try {
      const first = new MetadataManager({ ...makeCfg(), username: 'principal-a' }, client as never);
      expect(await first.getEntitySets()).toHaveLength(2);
      const restarted = new MetadataManager({ ...makeCfg(), username: 'principal-a' }, client as never);
      expect(await restarted.getEntitySets()).toHaveLength(2);
      const other = new MetadataManager({ ...makeCfg(), username: 'principal-b' }, client as never);
      expect(await other.getEntitySets()).toHaveLength(2);
      expect(requests.map((request) => request.etag)).toEqual([undefined, '"generation-one"', undefined]);
      expect(readdirSync(directory).filter((name) => name.endsWith('.json'))).toHaveLength(2);
      expect(readdirSync(directory).filter((name) => name.endsWith('.tmp'))).toHaveLength(0);
    } finally {
      if (prior === undefined) delete process.env.BPMSOFT_METADATA_CACHE_DIR;
      else process.env.BPMSOFT_METADATA_CACHE_DIR = prior;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('MetadataManager semantic ownership', () => {
  it('coalesces parallel requests for the same entity descriptor', async () => {
    const getMetadataXml = vi.fn(async () => ({ xml: SIMPLE_EDMX, notModified: false }));
    const request = vi.fn(async (options: { method: string }) =>
      options.method === 'GET'
        ? { data: { value: [{ UId: '11111111-1111-1111-1111-111111111111' }] } }
        : {
            data: {
              schema: {
                columns: [
                  {
                    name: 'Name',
                    caption: [{ cultureName: 'ru-RU', value: 'ФИО' }],
                    requirementType: 1,
                    defValue: { valueSourceType: 0 },
                  },
                ],
              },
            },
          }
    );
    const manager = new MetadataManager(makeCfg(), { getMetadataXml } as never, { request } as never);
    const descriptors = await Promise.all(
      Array.from({ length: 20 }, () => manager.getEntityMetadata('Contact'))
    );
    expect(getMetadataXml).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.filter(([options]) => options.method === 'POST')).toHaveLength(1);
    expect(descriptors.every((descriptor) => descriptor === descriptors[0])).toBe(true);
    expect(descriptors[0].properties.find((property) => property.name === 'Name')?.required).toBe(true);
  });

  it('exposes platform requirements independently from OData nullability and preserves default mechanisms', async () => {
    const xml = SIMPLE_EDMX.replace(
      '<Property Name="Name" Type="Edm.String"/>',
      '<Property Name="Name" Type="Edm.String"/><Property Name="Phone" Type="Edm.String" Nullable="false"/><Property Name="IsActive" Type="Edm.Boolean"/>'
    );
    const http = {
      async request(options: { method: string }) {
        if (options.method === 'GET')
          return { data: { value: [{ UId: '11111111-1111-1111-1111-111111111111' }] } };
        return {
          data: {
            schema: {
              inheritedColumns: [
                {
                  name: 'Id',
                  requirementType: 1,
                  defValue: { valueSourceType: 3, value: 'sample-generated-id' },
                },
                {
                  name: 'Name',
                  caption: [{ cultureName: 'ru-RU', value: 'ФИО' }],
                  requirementType: 1,
                  defValue: { valueSourceType: 0, value: null },
                },
                { name: 'Phone', requirementType: 0, defValue: { valueSourceType: 1, value: '' } },
                { name: 'IsActive', requirementType: 2, defValue: { valueSourceType: 1, value: false } },
                {
                  name: 'City',
                  requirementType: 2,
                  defValue: { valueSourceType: 2, value: 'sample-setting-value' },
                },
              ],
              columns: [],
            },
          },
        };
      },
    };
    const manager = new MetadataManager(
      makeCfg(),
      {
        async getMetadataXml() {
          return xml;
        },
      } as never,
      http as never
    );
    const properties = (await manager.getEntityMetadata('Contact')).properties;
    expect(properties.find((p) => p.name === 'Name')).toMatchObject({
      nullable: true,
      required: true,
      requirementSource: 'entity_schema_designer',
      defaultHint: { source: 'none', providedByServer: false },
    });
    expect(properties.find((p) => p.name === 'Phone')).toMatchObject({
      nullable: false,
      required: false,
      defaultHint: { source: 'constant', providedByServer: true, value: '' },
    });
    expect(properties.find((p) => p.name === 'IsActive')).toMatchObject({
      required: true,
      defaultHint: { source: 'constant', providedByServer: true, value: false },
    });
    expect(properties.find((p) => p.name === 'Id')?.defaultHint).toEqual({
      source: 'runtime',
      providedByServer: true,
    });
    expect(properties.find((p) => p.name === 'CityId')?.defaultHint).toEqual({
      source: 'system_setting',
      providedByServer: true,
    });
  });
  it('normalizes v3 d.results when locating a schema descriptor', async () => {
    const requests: string[] = [];
    const xml = SIMPLE_EDMX.replaceAll('CityId', 'City');
    const http = {
      async request(options: { method: string; url: string }) {
        requests.push(options.url);
        if (options.method === 'GET')
          return { data: { d: { results: [{ UId: '11111111-1111-1111-1111-111111111111' }] } } };
        return {
          data: {
            schema: {
              inheritedColumns: [
                {
                  name: 'Name',
                  caption: [{ cultureName: 'ru-RU', value: 'ФИО' }],
                  requirementType: 1,
                  defValue: { valueSourceType: 0 },
                },
              ],
            },
          },
        };
      },
    };
    const manager = new MetadataManager(
      { ...makeCfg(), odata_version: 3, platform: 'netframework' },
      {
        async getMetadataXml() {
          return xml;
        },
      } as never,
      http as never
    );
    const property = (await manager.getEntityMetadata('Contact')).properties.find((p) => p.name === 'Name');
    expect(property).toMatchObject({ caption: 'ФИО', required: true });
    expect(requests[0]).toContain('/SysSchemaCollection?');
    expect(requests[1]).toContain('/0/ServiceModel/EntitySchemaDesignerService.svc/GetSchema');
  });
  it('loads localized captions from a server schema with inherited columns', async () => {
    const calls: Array<{ method: string; url: string; body?: unknown; operation?: string }> = [];
    const http = {
      async request(options: { method: string; url: string; body?: unknown; operation?: string }) {
        calls.push(options);
        if (options.url.includes('/SysSchema?'))
          return { data: { value: [{ UId: '11111111-1111-1111-1111-111111111111', Name: 'Contact' }] } };
        if (options.url.endsWith('/EntitySchemaDesignerService.svc/GetSchema'))
          return {
            data: {
              schema: {
                inheritedColumns: [
                  {
                    name: 'City',
                    caption: [
                      { cultureName: 'en-US', value: 'City' },
                      { cultureName: 'ru-RU', value: 'Город' },
                    ],
                  },
                  { name: 'Name', caption: [{ cultureName: 'ru-RU', value: 'Имя' }] },
                ],
                columns: [{ name: 'Name', caption: [{ cultureName: 'ru-RU', value: 'ФИО' }] }],
              },
            },
          };
        throw Object.assign(new Error('Legacy caption table unavailable'), { httpStatus: 404 });
      },
    };
    const manager = new MetadataManager(
      makeCfg(),
      {
        async getMetadataXml() {
          return SIMPLE_EDMX;
        },
      } as never,
      http as never
    );
    expect(await manager.resolveFieldReference('Contact', 'Город')).toEqual({ name: 'CityId' });
    expect(await manager.resolveFieldReference('Contact', 'ФИО')).toEqual({ name: 'Name' });
    const designer = calls.find((call) => call.method === 'POST')!;
    expect(designer.operation).toBe('read');
    expect(designer.body).toEqual({ schemaUId: '11111111-1111-1111-1111-111111111111' });
    expect(calls[0].url).toContain("ManagerName eq 'EntitySchemaManager'");
    expect(calls).toHaveLength(2);
  });
  it('maps role navigation to its actual target rather than guessing its field name', async () => {
    const xml = SIMPLE_EDMX.replaceAll('CityId', 'OwnerId').replace(
      'NavigationProperty Name="City"',
      'NavigationProperty Name="Owner"'
    );
    const manager = new MetadataManager(makeCfg(), {
      async getMetadataXml() {
        return xml;
      },
    } as never);
    expect(await manager.getLookupInfo('Contact', 'OwnerId')).toEqual({
      lookupCollection: 'City',
      displayColumn: 'Name',
      navigationProperty: 'Owner',
    });
  });
  it('uses canonical v3 entity-set names and association roles', async () => {
    const xml = `<edmx:Edmx><edmx:DataServices><Schema Namespace="BPMSoft">
      <EntityType Name="Contact"><Property Name="Id" Type="Edm.Guid"/><Property Name="Owner" Type="Edm.Guid"/>
        <NavigationProperty Name="Owner" Relationship="BPMSoft.OwnerLink" ToRole="City"/></EntityType>
      <EntityType Name="City"><Property Name="Id" Type="Edm.Guid"/><Property Name="Name" Type="Edm.String"/></EntityType>
      <Association Name="OwnerLink"><End Role="Contact" Type="BPMSoft.Contact" Multiplicity="*"/><End Role="City" Type="BPMSoft.City" Multiplicity="0..1"/></Association>
      <EntityContainer><EntitySet Name="ContactCollection" EntityType="BPMSoft.Contact"/><EntitySet Name="CityCollection" EntityType="BPMSoft.City"/></EntityContainer>
    </Schema></edmx:DataServices></edmx:Edmx>`;
    const manager = new MetadataManager({ ...makeCfg(), odata_version: 3 }, {
      async getMetadataXml() {
        return xml;
      },
    } as never);
    expect(await manager.resolveCollectionReference('Contact')).toEqual({
      name: 'ContactCollection',
      autoCorrected: true,
    });
    expect(await manager.getLookupInfo('ContactCollection', 'Owner')).toEqual({
      lookupCollection: 'CityCollection',
      displayColumn: 'Name',
      navigationProperty: 'Owner',
    });
  });
  it('rejects ambiguous captions and honors explicit technical names', async () => {
    const manager = new MetadataManager(makeCfg(), {} as never);
    vi.spyOn(manager, 'getEntityMetadata').mockResolvedValue({
      name: 'Contact',
      collectionName: 'Contact',
      cachedAt: Date.now(),
      lookupFields: [],
      properties: ['Phone', 'MobilePhone'].map((name) => ({
        name,
        type: 'Edm.String',
        nullable: true,
        isLookup: false,
        caption: 'Телефон',
      })),
    });
    await expect(manager.resolveFieldReference('Contact', 'Телефон')).rejects.toThrow('неоднозначно');
    expect(await manager.resolveFieldReference('Contact', 'Phone')).toEqual({ name: 'Phone' });
  });
  it('does not share permission-dependent metadata across sessions', async () => {
    let calls = 0;
    const manager = new MetadataManager(makeCfg(), {
      async getMetadataXml() {
        calls++;
        return SIMPLE_EDMX;
      },
    } as never);
    await runWithAuth(extractAuthFromHeaders({ Cookie: 'BPMSESSIONID=a' }), () =>
      manager.getEntityMetadata('Contact')
    );
    await runWithAuth(extractAuthFromHeaders({ Cookie: 'BPMSESSIONID=b' }), () =>
      manager.getEntityMetadata('Contact')
    );
    expect(calls).toBe(2);
  });
  it('does not turn authorization failure into permanent caption capability failure', async () => {
    let allowed = false;
    const http = {
      async request(options: { url: string }) {
        if (!allowed) throw Object.assign(new Error('Forbidden'), { httpStatus: 403 });
        return {
          data: {
            value: options.url.includes('/SysSchema?')
              ? [{ UId: '11111111-1111-1111-1111-111111111111' }]
              : [{ Name: 'City', Caption: 'Город' }],
          },
        };
      },
    };
    const manager = new MetadataManager(
      makeCfg(),
      {
        async getMetadataXml() {
          return SIMPLE_EDMX;
        },
      } as never,
      http as never
    );
    await runWithAuth(extractAuthFromHeaders({ Cookie: 'BPMSESSIONID=a' }), () =>
      manager.getEntityMetadata('Contact')
    );
    allowed = true;
    const meta = await runWithAuth(extractAuthFromHeaders({ Cookie: 'BPMSESSIONID=b' }), () =>
      manager.getEntityMetadata('Contact')
    );
    expect(meta.properties.find((p) => p.name === 'CityId')?.caption).toBe('Город');
  });
});
