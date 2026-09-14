/**
 * bpm_get_relations: граф lookup-связей из EDMX, поиск путей и сам tool-handler.
 */

import { describe, it, expect, vi } from 'vitest';
import { MetadataManager } from '../../src/metadata/metadata-manager.js';
import { findPaths, registerRelationsTool } from '../../src/tools/relations-tool.js';
import type { ServiceContainer } from '../../src/tools/init-tool.js';
import type { BpmConfig } from '../../src/types/index.js';

const NS = 'BPMSoft.Configuration.OData';

function entity(name: string, lookups: Array<[string, string]>, extra = ''): string {
  const props = lookups.map(([nav]) => `<Property Name="${nav}Id" Type="Edm.Guid"/>`).join('');
  const navs = lookups.map(([nav, to]) => `<NavigationProperty Name="${nav}" Type="${NS}.${to}"/>`).join('');
  return (
    `<EntityType Name="${name}"><Property Name="Id" Type="Edm.Guid"/><Property Name="Name" Type="Edm.String"/>` +
    `<Property Name="CreatedById" Type="Edm.Guid"/><NavigationProperty Name="CreatedBy" Type="${NS}.Contact"/>` +
    `${props}${navs}${extra}</EntityType>`
  );
}

const TYPES: Array<[string, Array<[string, string]>, string?]> = [
  [
    'Contact',
    [
      ['Account', 'Account'],
      ['City', 'City'],
      ['Owner', 'Contact'],
    ],
    `<NavigationProperty Name="ActivityCollectionByContact" Type="Collection(${NS}.Activity)"/>`,
  ],
  ['Account', [['Owner', 'Contact']]],
  ['City', []],
  ['Activity', [['Contact', 'Contact']]],
  [
    'Opportunity',
    [
      ['Contact', 'Contact'],
      ['Account', 'Account'],
    ],
  ],
  ['Invoice', [['Opportunity', 'Opportunity']]],
  ['ContactFile', [['Contact', 'Contact']]],
  ['SysContactLog', [['Contact', 'Contact']]],
  ['VwContactList', [['Contact', 'Contact']]],
  ['Zebra', [['Contact', 'Contact']]],
  // Навигация без FK-колонки не считается lookup-связью.
  ['Broken', [], `<NavigationProperty Name="Contact" Type="${NS}.Contact"/>`],
];

const EDMX = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx" Version="4.0"><edmx:DataServices>
<Schema xmlns="http://docs.oasis-open.org/odata/ns/edm" Namespace="${NS}">
${TYPES.map(([n, l, x]) => entity(n, l, x)).join('\n')}
<EntityContainer Name="Container">
${TYPES.map(([n]) => `<EntitySet Name="${n}" EntityType="${NS}.${n}"/>`).join('\n')}
</EntityContainer></Schema></edmx:DataServices></edmx:Edmx>`;

/**
 * OData v3 (CSDL 2.0): у навигации нет Type, цель и кратность — в Association по ToRole,
 * EntitySet'ы называются XxxCollection, FK-колонка — `AccountId` рядом с навигацией `Account`.
 */
const V3_ASSOCIATIONS: Array<[string, string, string, string, string]> = [
  // [association, from type, to type, to role, to multiplicity]
  ['Contact_Account', 'Contact', 'Account', 'Account', '0..1'],
  ['Contact_Owner', 'Contact', 'Contact', 'Owner', '0..1'],
  ['Contact_CreatedBy', 'Contact', 'Contact', 'CreatedBy', '0..1'],
  ['Account_Owner', 'Account', 'Contact', 'Owner', '0..1'],
  ['Activity_Contact', 'Activity', 'Contact', 'Contact', '0..1'],
  ['Opportunity_Contact', 'Opportunity', 'Contact', 'Contact', '1'],
  ['SysContactLog_Contact', 'SysContactLog', 'Contact', 'Contact', '0..1'],
];

/** [nav, association, reverse] — reverse: навигация со стороны цели на конец "Source" (Multiplicity="*"). */
type V3Nav = [string, string, boolean?];

function v3Entity(name: string, navs: V3Nav[]): string {
  const props = navs
    .filter(([, , reverse]) => !reverse)
    .map(([nav]) => `<Property Name="${nav}Id" Type="Edm.Guid" Nullable="false"/>`)
    .join('');
  const navXml = navs
    .map(([nav, assoc, reverse]) => {
      const role = V3_ASSOCIATIONS.find(([a]) => a === assoc)![3];
      const [fromRole, toRole] = reverse ? [role, 'Source'] : ['Source', role];
      return `<NavigationProperty Name="${nav}" Relationship="${NS}.${assoc}" FromRole="${fromRole}" ToRole="${toRole}"/>`;
    })
    .join('');
  return (
    `<EntityType Name="${name}"><Key><PropertyRef Name="Id"/></Key><Property Name="Id" Type="Edm.Guid" Nullable="false"/>` +
    `<Property Name="Name" Type="Edm.String"/>${props}${navXml}</EntityType>`
  );
}

const V3_TYPES: Array<[string, V3Nav[]]> = [
  [
    'Contact',
    [
      ['Account', 'Contact_Account'],
      ['Owner', 'Contact_Owner'],
      ['CreatedBy', 'Contact_CreatedBy'],
      // Обратная сторона Activity_Contact: ToRole указывает на конец Multiplicity="*".
      ['ActivityCollectionByContact', 'Activity_Contact', true],
    ],
  ],
  ['Account', [['Owner', 'Account_Owner']]],
  ['Activity', [['Contact', 'Activity_Contact']]],
  ['Opportunity', [['Contact', 'Opportunity_Contact']]],
  ['SysContactLog', [['Contact', 'SysContactLog_Contact']]],
];

const V3_EDMX = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="1.0" xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx">
<edmx:DataServices m:DataServiceVersion="1.0" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata">
<Schema Namespace="${NS}" xmlns="http://schemas.microsoft.com/ado/2008/09/edm">
${V3_TYPES.map(([n, navs]) => v3Entity(n, navs)).join('\n')}
${V3_ASSOCIATIONS.map(
  ([a, from, to, role, mult]) =>
    `<Association Name="${a}"><End Type="${NS}.${from}" Role="Source" Multiplicity="*"/>` +
    `<End Type="${NS}.${to}" Role="${role}" Multiplicity="${mult}"/></Association>`
).join('\n')}
<EntityContainer Name="BPMSoft" m:IsDefaultEntityContainer="true">
${V3_TYPES.map(([n]) => `<EntitySet Name="${n}Collection" EntityType="${NS}.${n}"/>`).join('\n')}
</EntityContainer></Schema></edmx:DataServices></edmx:Edmx>`;

function makeManager(v3 = false): { mgr: MetadataManager; getMetadataXml: ReturnType<typeof vi.fn> } {
  process.env.BPMSOFT_METADATA_CACHE = 'off';
  const cfg = {
    bpmsoft_url: 'https://bpm.test',
    odata_version: v3 ? 3 : 4,
    platform: v3 ? 'netframework' : 'net8',
    lookup_cache_ttl: 300,
  } as BpmConfig;
  const xml = v3 ? V3_EDMX : EDMX;
  const getMetadataXml = vi.fn(async () => ({ xml }));
  const mgr = new MetadataManager(cfg, { getMetadataXml } as never);
  return { mgr, getMetadataXml };
}

describe('MetadataManager.getLookupGraph', () => {
  it('собирает исходящие и входящие lookup-связи без аудита и коллекционных навигаций', async () => {
    const { mgr } = makeManager();
    const graph = await mgr.getLookupGraph();

    expect(graph.outgoing.get('Contact')).toEqual([
      { from: 'Contact', field: 'AccountId', nav: 'Account', to: 'Account' },
      { from: 'Contact', field: 'CityId', nav: 'City', to: 'City' },
      { from: 'Contact', field: 'OwnerId', nav: 'Owner', to: 'Contact' },
    ]);
    const incoming = graph.incoming.get('Contact')!.map((e) => `${e.from}.${e.nav}`);
    expect(incoming).toContain('Activity.Contact');
    expect(incoming).not.toContain('Account.CreatedBy');
    expect(incoming).not.toContain('Broken.Contact');
    expect(graph.displayColumns.get('City')).toBe('Name');
  });

  it('строит граф один раз на загруженный EDMX', async () => {
    const { mgr, getMetadataXml } = makeManager();
    const first = await mgr.getLookupGraph();
    const second = await mgr.getLookupGraph();
    expect(second).toBe(first);
    expect(getMetadataXml).toHaveBeenCalledTimes(1);
  });
});

describe('findPaths', () => {
  it('прямой исходящий путь даёт criteria_field и odata_path', async () => {
    const graph = await makeManager().mgr.getLookupGraph();
    const [first] = findPaths(graph, 'Contact', 'Account');
    expect(first.steps).toEqual([
      { from: 'Contact', field: 'AccountId', nav: 'Account', to: 'Account', direction: 'out' },
    ]);
    expect(first.criteria_field).toBe('Account');
    expect(first.odata_path).toBe('Account');
    expect(first.query_collection).toBe('Contact');
  });

  it('двухшаговый исходящий путь: Contact.Account.Owner', async () => {
    const graph = await makeManager().mgr.getLookupGraph();
    const paths = findPaths(graph, 'Contact', 'Contact');
    const owner = paths.find((p) => p.criteria_field === 'Account.Owner');
    expect(owner?.odata_path).toBe('Account/Owner');
  });

  it('обратный шаг подсказывает искать с другой стороны', async () => {
    const graph = await makeManager().mgr.getLookupGraph();
    const paths = findPaths(graph, 'Contact', 'Opportunity');
    expect(paths[0].length).toBe(1);
    expect(paths[0].steps[0].direction).toBe('in');
    expect(paths[0].query_collection).toBe('Opportunity');
    expect(paths[0].criteria_field).toBe('Contact');
    expect(paths[0].hint).toBe('ищите в Opportunity по полю Contact = <Id Contact>');
    expect(paths.length).toBeLessThanOrEqual(5);
    // Более длинный смешанный путь через Account — без criteria_field.
    const mixed = paths.find((p) => p.steps.map((s) => s.direction).join() === 'out,in');
    expect(mixed?.criteria_field).toBeNull();
    expect(mixed?.hint).toContain('затем ищите в Opportunity по полю Account');
  });

  it('путь длиной 2 по входящим рёбрам и отсутствие пути', async () => {
    const graph = await makeManager().mgr.getLookupGraph();
    const [p] = findPaths(graph, 'Contact', 'Invoice');
    expect(p.length).toBe(2);
    expect(p.criteria_field).toBe('Opportunity.Contact');
    expect(p.query_collection).toBe('Invoice');
    expect(findPaths(graph, 'City', 'Broken')).toEqual([]);
  });

  it('не водит путь через Sys*/Vw* без include_system', async () => {
    const graph = await makeManager().mgr.getLookupGraph();
    const viaSystem = (paths: ReturnType<typeof findPaths>) =>
      paths.some((p) => p.steps.slice(0, -1).some((s) => /^(Sys|Vw)/.test(s.to)));
    expect(viaSystem(findPaths(graph, 'Activity', 'Zebra'))).toBe(false);
  });
});

describe('OData v3: граф по Association и пути с FK-колонкой', () => {
  it('разрешает навигации через Association.End по ToRole, коллекционные и аудит пропускает', async () => {
    const graph = await makeManager(true).mgr.getLookupGraph();
    expect(graph.odataVersion).toBe(3);
    expect(graph.outgoing.get('ContactCollection')).toEqual([
      { from: 'ContactCollection', field: 'AccountId', nav: 'Account', to: 'AccountCollection' },
      { from: 'ContactCollection', field: 'OwnerId', nav: 'Owner', to: 'ContactCollection' },
    ]);
    expect(graph.outgoing.get('ActivityCollection')).toEqual([
      { from: 'ActivityCollection', field: 'ContactId', nav: 'Contact', to: 'ContactCollection' },
    ]);
    const allNavs = [...graph.outgoing.values()].flat().map((e) => e.nav);
    expect(allNavs).not.toContain('ActivityCollectionByContact');
    expect(allNavs).not.toContain('CreatedBy');
    // Multiplicity="1" — тоже одиночная навигация.
    expect(graph.incoming.get('ContactCollection')!.map((e) => e.from)).toContain('OpportunityCollection');
  });

  it('пути дают v3-валидные criteria_field/odata_path и имена XxxCollection', async () => {
    const graph = await makeManager(true).mgr.getLookupGraph();
    const [direct] = findPaths(graph, 'ContactCollection', 'AccountCollection');
    expect(direct.query_collection).toBe('ContactCollection');
    expect(direct.criteria_field).toBe('AccountId');
    expect(direct.odata_path).toBe('AccountId');
    expect(direct.hint).toBe('ищите в ContactCollection по полю AccountId = <Id AccountCollection>');

    const owner = findPaths(graph, 'ContactCollection', 'ContactCollection').find(
      (p) => p.odata_path === 'Account/OwnerId'
    );
    expect(owner?.criteria_field).toBe('Account.OwnerId');

    const [reverse] = findPaths(graph, 'ContactCollection', 'OpportunityCollection');
    expect(reverse.steps[0].direction).toBe('in');
    expect(reverse.query_collection).toBe('OpportunityCollection');
    expect(reverse.odata_path).toBe('ContactId');
  });
});

describe('bpm_get_relations handler', () => {
  async function call(args: Record<string, unknown>, v3 = false) {
    const { mgr } = makeManager(v3);
    const server = { registerTool: vi.fn() };
    const services = {
      initialized: true,
      authManager: { ensureAuthenticated: vi.fn(async () => undefined) },
      metadataManager: {
        getLookupGraph: () => mgr.getLookupGraph(),
        getEntityMetadata: vi.fn(async () => ({
          properties: [{ name: 'AccountId', caption: 'Контрагент' }],
        })),
        resolveCollectionReference: vi.fn(async (q: string) => ({
          name: q === 'Контакт' ? 'Contact' : q === 'Сделка' ? 'Opportunity' : q,
        })),
      },
    } as unknown as ServiceContainer;
    registerRelationsTool(server as never, services);
    const handler = server.registerTool.mock.calls[0][2] as (a: unknown) => Promise<{
      content: Array<{ text: string }>;
      structuredContent: {
        collection: string;
        outgoing: unknown[];
        incoming?: Array<{ collection: string }>;
        incoming_total: number;
        paths: Array<{ hint: string }>;
      };
      isError?: boolean;
    }>;
    return handler(args);
  }

  it('резолвит русские имена, ранжирует входящие и режет по limit', async () => {
    const res = await call({ collection: 'Контакт', target: 'Сделка', limit: 3 });
    const s = res.structuredContent;
    expect(res.isError).toBeFalsy();
    expect(s.collection).toBe('Contact');
    expect(s.outgoing[0]).toEqual({
      field: 'AccountId',
      nav: 'Account',
      target: 'Account',
      display_column: 'Name',
      caption: 'Контрагент',
    });
    // Contact.Owner, Account, Activity, Opportunity, ContactFile, Zebra — без Sys*/Vw*.
    expect(s.incoming_total).toBe(6);
    expect(s.incoming.map((i: { collection: string }) => i.collection)).toEqual([
      'Contact',
      'Account',
      'Activity',
    ]);
    expect(s.paths[0].hint).toContain('ищите в Opportunity');
    expect(res.content[0].text).toContain('Пути Contact -> Opportunity');
  });

  it('include_system возвращает Sys*/Vw*, direction=out убирает входящие', async () => {
    const all = await call({ collection: 'Contact', include_system: true, limit: 100 });
    expect(all.structuredContent.incoming_total).toBe(8);
    const rank = all.structuredContent.incoming.map((i: { collection: string }) => i.collection);
    expect(rank.indexOf('ContactFile')).toBeLessThan(rank.indexOf('SysContactLog'));

    const out = await call({ collection: 'Contact', direction: 'out' });
    expect(out.structuredContent.incoming).toBeUndefined();
    expect(out.structuredContent.outgoing).toHaveLength(3);
  });

  it('v3: «Contact» → ContactCollection, Sys*Collection скрыты, заметки о пустом графе нет', async () => {
    const res = await call({ collection: 'Contact', target: 'Account' }, true);
    const s = res.structuredContent as typeof res.structuredContent & { note?: string };
    expect(res.isError).toBeFalsy();
    expect(s.collection).toBe('ContactCollection');
    expect(s.note).toBeUndefined();
    expect(s.incoming!.map((i) => i.collection)).toEqual([
      'ContactCollection',
      'AccountCollection',
      'ActivityCollection',
      'OpportunityCollection',
    ]);
    expect(s.paths[0].hint).toBe('ищите в ContactCollection по полю AccountId = <Id AccountCollection>');
  });
});
