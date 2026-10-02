import { describe, it, expect, vi, afterEach } from 'vitest';
import { BpmApiError } from '../../src/utils/errors.js';
import { runWithAuth } from '../../src/auth/request-context.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { HttpClient } from '../../src/client/http-client.js';
import { ODataClient } from '../../src/client/odata-client.js';
import { buildConfig } from '../../src/config.js';
import {
  buildProfile,
  toDedupRecord,
  planFillFields,
  registerDedupTools,
} from '../../src/tools/dedup-tools.js';
import type { ServiceContainer } from '../../src/tools/init-tool.js';
import type { EntityMetadata, EntityProperty } from '../../src/types/index.js';

function meta(collection: string, props: Array<[string, string, string?]>): EntityMetadata {
  const properties = props.map(
    ([name, type, lookupCollection]) =>
      ({
        name,
        type,
        nullable: true,
        isLookup: Boolean(lookupCollection),
        lookupCollection,
      }) as EntityProperty
  );
  return { name: collection, collectionName: collection, properties, lookupFields: [], cachedAt: 0 };
}

const CONTACT = meta('Contact', [
  ['Id', 'Edm.Guid'],
  ['Name', 'Edm.String'],
  ['Email', 'Edm.String'],
  ['IsEmailConfirmed', 'Edm.Boolean'],
  ['DoNotUseEmail', 'Edm.Boolean'],
  ['Phone', 'Edm.String'],
  ['MobilePhone', 'Edm.String'],
  ['AccountId', 'Edm.Guid', 'Account'],
  ['BirthDate', 'Edm.DateTimeOffset'],
  ['JobTitle', 'Edm.String'],
  ['Age', 'Edm.Int32'],
  ['CreatedOn', 'Edm.DateTimeOffset'],
]);

describe('dedup-tools: профиль и записи', () => {
  it('профиль контакта находит почту, телефоны, контрагента и дату рождения, без флагов', () => {
    const profile = buildProfile('Contact', CONTACT, 'Name');
    expect(profile).toMatchObject({
      kind: 'person',
      nameField: 'Name',
      emailFields: ['Email'],
      phoneFields: ['Phone', 'MobilePhone'],
      accountField: 'AccountId',
      birthField: 'BirthDate',
    });
  });

  it('профиль контрагента — организация, сайт и ИНН из пользовательской колонки', () => {
    const account = meta('Account', [
      ['Id', 'Edm.Guid'],
      ['Name', 'Edm.String'],
      ['Web', 'Edm.String'],
      ['UsrInn', 'Edm.String'],
    ]);
    expect(buildProfile('Account', account, 'Name')).toMatchObject({
      kind: 'organization',
      websiteField: 'Web',
      innField: 'UsrInn',
    });
  });

  it('запись собирает телефоны и почту из полей и средств связи, пустые значения отбрасывает', () => {
    const profile = buildProfile('Contact', CONTACT, 'Name');
    const record = toDedupRecord(
      {
        Id: 'c1',
        Name: ' Иванов Иван ',
        Email: '',
        Phone: '+7 (916) 555-12-34',
        MobilePhone: '123',
        AccountId: '00000000-0000-0000-0000-000000000000',
        BirthDate: '0001-01-01T00:00:00Z',
        CreatedOn: '2026-09-01T00:00:00Z',
      },
      profile,
      ['ivan@gmail.com', '8 916 555 00 00', 'romashka.ru']
    );
    expect(record).toMatchObject({
      id: 'c1',
      kind: 'person',
      name: 'Иванов Иван',
      emails: ['ivan@gmail.com'],
      phones: ['+7 (916) 555-12-34', '8 916 555 00 00'],
      website: 'romashka.ru',
      accountId: undefined,
      birthDate: undefined,
    });
  });
});

describe('dedup-tools: planFillFields', () => {
  it('заполняет только пустые текстовые, ссылочные и датовые поля основной записи', () => {
    const fill = planFillFields(
      CONTACT,
      {
        Id: 'm',
        Name: 'Иванов',
        Email: '',
        JobTitle: 'Директор',
        AccountId: '00000000-0000-0000-0000-000000000000',
        Age: 0,
      },
      [
        {
          Id: 'd1',
          Name: 'Иван Иванов',
          Email: 'ivan@x.ru',
          JobTitle: 'Менеджер',
          AccountId: 'acc-1',
          Age: 40,
        },
        { Id: 'd2', Email: 'other@x.ru', Phone: '+7 916 000 00 00' },
      ]
    );
    expect(fill).toEqual({ Email: 'ivan@x.ru', AccountId: 'acc-1', Phone: '+7 916 000 00 00' });
  });
});

interface MergeResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}
type MergeHandler = (args: Record<string, unknown>) => Promise<MergeResult>;
type MergeResultBody = { repointed: number; failed: unknown[]; deleted: string[] };

const MASTER = 'aaaaaaaa-0000-0000-0000-000000000001';
const DUP = 'aaaaaaaa-0000-0000-0000-000000000002';
const REF_1 = 'bbbbbbbb-0000-0000-0000-000000000001';
const REF_2 = 'bbbbbbbb-0000-0000-0000-000000000002';

type Row = Record<string, unknown>;
function setupMerge(
  opts: {
    references?: number;
    failIds?: string[];
    unknownIds?: string[];
    countFails?: boolean;
    unreadableCollections?: string[];
    incomplete?: boolean;
    blocked?: boolean;
    fill?: boolean;
    etag?: boolean;
  } = {}
) {
  const graph = new Map<string, Array<{ from: string; field: string; nav: string | null }>>();
  graph.set('Contact', [
    { from: 'Activity', field: 'ContactId', nav: 'Contact' },
    ...(opts.blocked ? [{ from: 'SysReference', field: 'ContactId', nav: 'Contact' }] : []),
  ]);
  const records = new Map<string, Row>([
    [
      `Contact:${MASTER}`,
      { Id: MASTER, Name: 'Master', Email: '', ...(opts.etag === false ? {} : { '@odata.etag': 'W/"1"' }) },
    ],
    [
      `Contact:${DUP}`,
      {
        Id: DUP,
        Name: 'Duplicate',
        Email: opts.fill ? 'duplicate@example.test' : '',
        ...(opts.etag === false ? {} : { '@odata.etag': 'W/"1"' }),
      },
    ],
    ...[REF_1, REF_2]
      .slice(0, opts.references ?? 0)
      .map(
        (id) =>
          [
            `Activity:${id}`,
            { Id: id, ContactId: DUP, Title: id, ...(opts.etag === false ? {} : { '@odata.etag': 'W/"1"' }) },
          ] as [string, Row]
      ),
    ...(opts.blocked ? [[`SysReference:${REF_2}`, { Id: REF_2, ContactId: DUP }] as [string, Row]] : []),
  ]);
  const odataClient = {
    getRecord: vi.fn(async (collection: string, id: string) => {
      const row = records.get(`${collection}:${id}`);
      if (!row) throw new BpmApiError('Not found', 404, collection);
      return { ...row };
    }),
    getRecords: vi.fn(async (collection: string, query?: { $filter?: string; $count?: boolean }) => {
      if (opts.countFails || opts.unreadableCollections?.includes(collection))
        throw new BpmApiError('Read denied', 403, collection);
      const target = query?.$filter?.match(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
      )?.[0];
      const value = [...records.entries()]
        .filter(([key, row]) => key.startsWith(`${collection}:`) && row.ContactId === target)
        .map(([, row]) => ({ ...row }));
      return {
        value,
        ...(opts.incomplete
          ? {
              '@odata.nextLink': 'https://crm.example.test/odata/Activity?$skip=2',
              '@odata.count': value.length + 1,
            }
          : { '@odata.count': value.length }),
      };
    }),
    updateRecord: vi.fn(
      async (collection: string, id: string, data: Row, _options?: { expectedEtag?: string }) => {
        if (opts.unknownIds?.includes(id))
          throw new BpmApiError(
            'Response lost',
            0,
            collection,
            undefined,
            undefined,
            undefined,
            'outcome_unknown'
          );
        if (opts.failIds?.includes(id)) throw new BpmApiError('Write denied', 403, collection);
        const old = records.get(`${collection}:${id}`)!;
        records.set(`${collection}:${id}`, {
          ...old,
          ...data,
          ...(opts.etag === false ? {} : { '@odata.etag': 'W/"2"' }),
        });
        return null;
      }
    ),
    deleteRecord: vi.fn(async (collection: string, id: string, _options?: { expectedEtag?: string }) => {
      if (opts.unknownIds?.includes(id))
        throw new BpmApiError(
          'Delete response lost',
          0,
          collection,
          undefined,
          undefined,
          undefined,
          'outcome_unknown'
        );
      if (opts.failIds?.includes(id)) throw new BpmApiError('Delete denied', 403, collection);
      records.delete(`${collection}:${id}`);
    }),
  };
  const services = {
    initialized: true,
    config: { bpmsoft_url: 'https://crm.example.test', username: 'tester', odata_version: 4 },
    authManager: { ensureAuthenticated: async () => undefined },
    metadataManager: {
      resolveCollectionReference: async (collection: string) => ({ name: collection }),
      getEntityMetadata: async () => CONTACT,
      getLookupGraph: async () => ({ incoming: graph, outgoing: new Map() }),
      getEntitySets: async () => [],
    },
    lookupResolver: { resolve: async () => ({ resolved: false, matchCount: 0, candidates: [] }) },
    odataClient,
  } as unknown as ServiceContainer;
  const handlers = new Map<string, MergeHandler>();
  registerDedupTools(
    {
      registerTool: (name: string, _metadata: unknown, handler: MergeHandler) => handlers.set(name, handler),
    } as never,
    services
  );
  const handler = handlers.get('bpm_merge_duplicates')!;
  const args = { collection: 'Contact', master_id: MASTER, duplicate_ids: [DUP] };
  const confirm = async (extra: Record<string, unknown> = {}) => {
    const input = { ...args, ...extra };
    const preview = await handler(input);
    if (preview.isError) return preview;
    return handler({
      ...input,
      confirm: true,
      expected_references: preview.structuredContent?.expected_references,
      confirmation_token: preview.structuredContent?.confirmation_token,
    });
  };
  return { handler, args, confirm, odataClient, records, graph, services };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('bpm_merge_duplicates: exact confirmed execution', () => {
  it('previews exact reference UUIDs and performs no write until the token is supplied', async () => {
    const env = setupMerge({ references: 2 });
    const preview = await env.handler(env.args);
    expect(preview.structuredContent).toMatchObject({
      requires_confirmation: true,
      confirmation_token: expect.any(String),
      expected_references: 2,
      concurrency_protection: 'etag',
      reference_records: [
        { collection: 'Activity', id: REF_1, fields: ['ContactId'] },
        { collection: 'Activity', id: REF_2, fields: ['ContactId'] },
      ],
    });
    expect(env.odataClient.updateRecord).not.toHaveBeenCalled();
    expect(env.odataClient.deleteRecord).not.toHaveBeenCalled();
    expect((await env.handler({ ...env.args, confirm: true, expected_references: 2 })).isError).toBe(true);
    expect(env.odataClient.updateRecord).not.toHaveBeenCalled();
  });
  it('repoints all references, verifies zero remaining links, and deletes the duplicate with its version', async () => {
    const env = setupMerge({ references: 2 });
    const result = await env.confirm();
    expect(result.isError).toBe(false);
    expect(result.structuredContent?.result).toMatchObject({
      repointed: 2,
      failed: [],
      deleted: [DUP],
      kept: [],
      snapshots: [expect.objectContaining({ Id: DUP })],
    });
    expect(env.odataClient.updateRecord).toHaveBeenNthCalledWith(
      1,
      'Activity',
      REF_1,
      { ContactId: MASTER },
      { expectedEtag: 'W/"1"' }
    );
    expect(env.odataClient.deleteRecord).toHaveBeenCalledWith('Contact', DUP, { expectedEtag: 'W/"1"' });
    expect(env.records.get(`Activity:${REF_1}`)?.ContactId).toBe(MASTER);
    expect(env.records.has(`Contact:${DUP}`)).toBe(false);
  });
  it('fills known empty master fields and exposes the successful step', async () => {
    const env = setupMerge({ fill: true });
    const result = await env.confirm({ keep_duplicates: true });
    expect(result.isError).toBe(false);
    expect(env.records.get(`Contact:${MASTER}`)?.Email).toBe('duplicate@example.test');
    expect(result.structuredContent?.outcomes).toEqual([
      expect.objectContaining({ step: 'fill', state: 'succeeded', id: MASTER }),
    ]);
    expect(env.odataClient.deleteRecord).not.toHaveBeenCalled();
  });
  it('keeps duplicates on explicit request while repointing verified references', async () => {
    const env = setupMerge({ references: 1 });
    const result = await env.confirm({ keep_duplicates: true, fill_empty_fields: false });
    expect(result.isError).toBe(false);
    expect(result.structuredContent?.result).toMatchObject({ repointed: 1, deleted: [], kept: [DUP] });
    expect(env.odataClient.deleteRecord).not.toHaveBeenCalled();
  });
  it('rejects same-count replacement of the reference set', async () => {
    const env = setupMerge({ references: 1 });
    const preview = await env.handler(env.args);
    const old = env.records.get(`Activity:${REF_1}`)!;
    env.records.delete(`Activity:${REF_1}`);
    env.records.set(`Activity:${REF_2}`, { ...old, Id: REF_2 });
    const result = await env.handler({
      ...env.args,
      confirm: true,
      expected_references: 1,
      confirmation_token: preview.structuredContent?.confirmation_token,
    });
    expect(result.isError).toBe(true);
    expect(env.odataClient.updateRecord).not.toHaveBeenCalled();
    expect(env.odataClient.deleteRecord).not.toHaveBeenCalled();
  });
  it.each(['master', 'duplicate', 'reference'])(
    'rejects changed %s contents after preview',
    async (target) => {
      const env = setupMerge({ references: 1 });
      const preview = await env.handler(env.args);
      const key =
        target === 'master'
          ? `Contact:${MASTER}`
          : target === 'duplicate'
            ? `Contact:${DUP}`
            : `Activity:${REF_1}`;
      env.records.set(key, { ...env.records.get(key), Notes: 'Concurrent edit' });
      expect(
        (
          await env.handler({
            ...env.args,
            confirm: true,
            expected_references: 1,
            confirmation_token: preview.structuredContent?.confirmation_token,
          })
        ).isError
      ).toBe(true);
      expect(env.odataClient.updateRecord).not.toHaveBeenCalled();
      expect(env.odataClient.deleteRecord).not.toHaveBeenCalled();
    }
  );
  it('binds destructive flags, consumes the token once, and rejects cross-principal confirmation', async () => {
    const env = setupMerge({ references: 1 });
    const first = { cookies: new Map([['BPMSESSIONID', 'test-session-a']]) };
    const second = { cookies: new Map([['BPMSESSIONID', 'test-session-b']]) };
    const preview = await runWithAuth(first, () => env.handler({ ...env.args, keep_duplicates: true }));
    const confirmed = {
      ...env.args,
      keep_duplicates: true,
      confirm: true,
      expected_references: 1,
      confirmation_token: preview.structuredContent?.confirmation_token,
    };
    expect((await runWithAuth(second, () => env.handler(confirmed))).isError).toBe(true);
    expect(
      (await runWithAuth(first, () => env.handler({ ...confirmed, fill_empty_fields: false }))).isError
    ).toBe(true);
    expect(env.odataClient.updateRecord).not.toHaveBeenCalled();
    expect((await runWithAuth(first, () => env.handler(confirmed))).isError).toBe(false);
    expect((await runWithAuth(first, () => env.handler(confirmed))).isError).toBe(true);
    expect(env.odataClient.updateRecord).toHaveBeenCalledTimes(1);
  });
  it('rejects expired confirmation without mutations', async () => {
    vi.useFakeTimers();
    const env = setupMerge();
    const preview = await env.handler(env.args);
    vi.advanceTimersByTime(10 * 60_000 + 1);
    expect(
      (
        await env.handler({
          ...env.args,
          confirm: true,
          expected_references: 0,
          confirmation_token: preview.structuredContent?.confirmation_token,
        })
      ).isError
    ).toBe(true);
    expect(env.odataClient.deleteRecord).not.toHaveBeenCalled();
  });
  it('reports partial failure and leaves dependent writes unexecuted', async () => {
    const env = setupMerge({ references: 2, failIds: [REF_2] });
    const result = await env.confirm();
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.result).toMatchObject({
      repointed: 1,
      failed: [expect.objectContaining({ id: REF_2 })],
      deleted: [],
      kept: [DUP],
    });
    expect(result.structuredContent?.outcomes).toEqual([
      expect.objectContaining({ state: 'succeeded' }),
      expect.objectContaining({ state: 'failed' }),
      expect.objectContaining({ state: 'not_executed', step: 'delete' }),
    ]);
    expect(env.odataClient.deleteRecord).not.toHaveBeenCalled();
  });
  it('stops after the first failure instead of issuing later repoints', async () => {
    const env = setupMerge({ references: 2, failIds: [REF_1, REF_2] });
    const result = await env.confirm();
    expect(result.isError).toBe(true);
    expect((result.structuredContent?.result as MergeResultBody).failed).toHaveLength(1);
    expect(env.odataClient.updateRecord).toHaveBeenCalledTimes(1);
    expect(env.odataClient.deleteRecord).not.toHaveBeenCalled();
  });
  it.each(['fill', 'repoint', 'delete'])(
    'stops all dependent mutations after an uncertain %s',
    async (step) => {
      const env = setupMerge({
        references: 2,
        fill: step === 'fill',
        unknownIds: [step === 'fill' ? MASTER : step === 'repoint' ? REF_1 : DUP],
      });
      const result = await env.confirm();
      expect(result.isError).toBe(true);
      const outcomes = result.structuredContent?.outcomes as Array<{ step: string; state: string }>;
      const unknown = outcomes.findIndex((outcome) => outcome.state === 'outcome_unknown');
      expect(unknown).toBeGreaterThanOrEqual(0);
      expect(outcomes[unknown].step).toBe(step);
      expect(outcomes.slice(unknown + 1).every((outcome) => outcome.state === 'not_executed')).toBe(true);
      expect((result.structuredContent?.result as MergeResultBody).deleted).toEqual([]);
      if (step !== 'delete') expect(env.odataClient.deleteRecord).not.toHaveBeenCalled();
    }
  );
  it('refuses deletion for an unreadable source even with legacy allow_unreadable_sources', async () => {
    const env = setupMerge({ countFails: true });
    const result = await env.handler({ ...env.args, allow_unreadable_sources: true });
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.code).toBe('reference_selection_incomplete');
    expect(env.odataClient.updateRecord).not.toHaveBeenCalled();
    expect(env.odataClient.deleteRecord).not.toHaveBeenCalled();
  });
  it('reports successful confirmed repoints with incomplete coverage when duplicates are explicitly kept', async () => {
    const env = setupMerge({
      references: 1,
      blocked: true,
      unreadableCollections: ['SysReference'],
    });
    const refused = await env.handler(env.args);
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent?.code).toBe('reference_selection_incomplete');
    expect(refused.structuredContent?.confirmation_token).toBeUndefined();
    expect(env.odataClient.updateRecord).not.toHaveBeenCalled();
    expect(env.odataClient.deleteRecord).not.toHaveBeenCalled();

    const input = { ...env.args, keep_duplicates: true, fill_empty_fields: false };
    const preview = await env.handler(input);
    expect(preview.isError).not.toBe(true);
    expect(preview.structuredContent).toMatchObject({
      requires_confirmation: true,
      count_failures: ['SysReference.ContactId: Read denied'],
      reference_records: [{ collection: 'Activity', id: REF_1, fields: ['ContactId'] }],
    });
    expect(env.odataClient.updateRecord).not.toHaveBeenCalled();
    const result = await env.handler({
      ...input,
      confirm: true,
      expected_references: preview.structuredContent?.expected_references,
      confirmation_token: preview.structuredContent?.confirmation_token,
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      count_failures: ['SysReference.ContactId: Read denied'],
      outcomes: [{ step: 'repoint', collection: 'Activity', id: REF_1, state: 'succeeded' }],
      result: { repointed: 1, failed: [], deleted: [], kept: [DUP] },
    });
    expect(env.odataClient.updateRecord).toHaveBeenCalledTimes(1);
    expect(env.odataClient.deleteRecord).not.toHaveBeenCalled();
    expect(env.records.get(`Activity:${REF_1}`)?.ContactId).toBe(MASTER);
    expect(env.records.get(`SysReference:${REF_2}`)?.ContactId).toBe(DUP);
    expect(env.records.has(`Contact:${DUP}`)).toBe(true);
    const text = result.content.map((item) => item.text).join('\n');
    expect(text).toContain('Обзор ссылок остаётся неполным');
    expect(text).toContain('Выполнение ограничено проверенными ссылками; дубли сохранены');
    expect(text).toContain('count_failures');
  });
  it('still reports a failed mutation in the explicitly retained incomplete scope', async () => {
    const env = setupMerge({
      references: 1,
      blocked: true,
      unreadableCollections: ['SysReference'],
      failIds: [REF_1],
    });
    const result = await env.confirm({ keep_duplicates: true, fill_empty_fields: false });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      count_failures: ['SysReference.ContactId: Read denied'],
      outcomes: [{ step: 'repoint', id: REF_1, state: 'failed' }],
      result: { repointed: 0, failed: [expect.objectContaining({ id: REF_1 })], deleted: [], kept: [DUP] },
    });
    expect(env.records.get(`Activity:${REF_1}`)?.ContactId).toBe(DUP);
    expect(env.odataClient.deleteRecord).not.toHaveBeenCalled();
  });
  it('keeps duplicates when system references cannot be repointed', async () => {
    const env = setupMerge({ blocked: true });
    const result = await env.handler(env.args);
    expect(result.isError).toBe(true);
    expect(env.odataClient.deleteRecord).not.toHaveBeenCalled();
    const retained = await env.confirm({ keep_duplicates: true });
    expect(retained.structuredContent?.result).toMatchObject({ deleted: [], kept: [DUP] });
  });
  it('rejects incomplete paginated reference selection before any change', async () => {
    const env = setupMerge({ references: 1, incomplete: true });
    const result = await env.handler(env.args);
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.code).toBe('reference_selection_incomplete');
    expect(env.odataClient.updateRecord).not.toHaveBeenCalled();
    expect(env.odataClient.deleteRecord).not.toHaveBeenCalled();
  });
  it('enforces the reference cap and rejects unknown rows beyond it', async () => {
    const env = setupMerge({ references: 2 });
    const result = await env.handler({ ...env.args, max_references: 1 });
    expect(result.isError).toBe(true);
    expect(env.odataClient.updateRecord).not.toHaveBeenCalled();
    expect(env.odataClient.deleteRecord).not.toHaveBeenCalled();
  });
  it('detects a newly added reference before deleting any duplicate', async () => {
    const env = setupMerge({ references: 1 });
    const implementation = env.odataClient.updateRecord.getMockImplementation()!;
    env.odataClient.updateRecord.mockImplementation(async (...args) => {
      await implementation(...args);
      env.records.set(`Activity:${REF_2}`, { Id: REF_2, ContactId: DUP, Title: 'New reference' });
      return null;
    });
    const result = await env.confirm();
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.result).toMatchObject({ repointed: 1, deleted: [], kept: [DUP] });
    expect(env.odataClient.deleteRecord).not.toHaveBeenCalled();
  });
  it('groups different fields of one reference record into one version-protected PATCH', async () => {
    const env = setupMerge({ references: 1 });
    env.graph.get('Contact')!.push({ from: 'Activity', field: 'OwnerId', nav: 'Owner' });
    env.records.set(`Activity:${REF_1}`, { ...env.records.get(`Activity:${REF_1}`), OwnerId: DUP });
    env.odataClient.getRecords.mockImplementation(async () => ({
      value: [{ ...env.records.get(`Activity:${REF_1}`)! }],
      '@odata.count': 1,
    }));
    const result = await env.confirm({ keep_duplicates: true });
    expect(result.isError).toBe(false);
    expect(env.odataClient.updateRecord).toHaveBeenCalledTimes(1);
    expect(env.odataClient.updateRecord).toHaveBeenCalledWith(
      'Activity',
      REF_1,
      { ContactId: MASTER, OwnerId: MASTER },
      { expectedEtag: 'W/"1"' }
    );
    expect(result.structuredContent?.result).toMatchObject({ repointed: 2 });
  });
  it('reports honest snapshot-only protection where the platform omits ETags', async () => {
    const env = setupMerge({ references: 1, etag: false });
    const preview = await env.handler(env.args);
    expect(preview.structuredContent?.concurrency_protection).toBe('snapshot_only');
    expect(
      (
        await env.handler({
          ...env.args,
          confirm: true,
          expected_references: 1,
          confirmation_token: preview.structuredContent?.confirmation_token,
        })
      ).isError
    ).toBe(false);
  });
  it('rejects direct confirmation when an expected reference count no longer matches', async () => {
    const env = setupMerge({ references: 1 });
    const preview = await env.handler(env.args);
    const result = await env.handler({
      ...env.args,
      confirm: true,
      expected_references: 2,
      confirmation_token: preview.structuredContent?.confirmation_token,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.code).toBe('expected_count_mismatch');
    expect(env.odataClient.updateRecord).not.toHaveBeenCalled();
  });
});

describe('merge source and deletion boundaries', () => {
  it('supports complete paginated source reads when inline count is unsupported', async () => {
    const env = setupMerge({ references: 1 });
    const original = env.odataClient.getRecords.getMockImplementation()!;
    env.odataClient.getRecords.mockImplementation(async (collection, query) => {
      if (query?.$count) throw new BpmApiError('Inline count unsupported', 400, collection);
      return original(collection, query);
    });
    expect((await env.confirm()).isError).toBe(false);
    expect(env.odataClient.deleteRecord).toHaveBeenCalledTimes(1);
  });
  it('stops before a second duplicate deletion when the first response is uncertain', async () => {
    const env = setupMerge({ unknownIds: [DUP] });
    const second = 'aaaaaaaa-0000-0000-0000-000000000003';
    env.records.set(`Contact:${second}`, { Id: second, Name: 'Second', Email: '', '@odata.etag': 'W/"1"' });
    const result = await env.confirm({ duplicate_ids: [DUP, second] });
    expect(result.isError).toBe(true);
    expect(env.odataClient.deleteRecord).toHaveBeenCalledTimes(1);
    expect(result.structuredContent?.outcomes).toEqual([
      expect.objectContaining({ id: DUP, state: 'outcome_unknown' }),
      expect.objectContaining({ id: second, state: 'not_executed' }),
    ]);
  });
  it('checks each duplicate for new links immediately before its deletion', async () => {
    const env = setupMerge();
    const second = 'aaaaaaaa-0000-0000-0000-000000000003';
    env.records.set(`Contact:${second}`, { Id: second, Name: 'Second', Email: '', '@odata.etag': 'W/"1"' });
    const original = env.odataClient.deleteRecord.getMockImplementation()!;
    env.odataClient.deleteRecord.mockImplementation(async (...args) => {
      await original(...args);
      env.records.set(`Activity:${REF_1}`, { Id: REF_1, ContactId: second });
    });
    const result = await env.confirm({ duplicate_ids: [DUP, second] });
    expect(result.isError).toBe(true);
    expect(env.odataClient.deleteRecord).toHaveBeenCalledTimes(1);
    expect(result.structuredContent?.result).toMatchObject({ deleted: [DUP], kept: [second] });
  });
});

describe('merge token consumption', () => {
  it('cannot replay a consumed token even when no record or reference changed', async () => {
    const env = setupMerge();
    const args = { ...env.args, keep_duplicates: true };
    const preview = await env.handler(args);
    const confirmed = {
      ...args,
      confirm: true,
      expected_references: 0,
      confirmation_token: preview.structuredContent?.confirmation_token,
    };
    expect((await env.handler(confirmed)).isError).toBe(false);
    expect((await env.handler(confirmed)).isError).toBe(true);
    expect(env.odataClient.updateRecord).not.toHaveBeenCalled();
    expect(env.odataClient.deleteRecord).not.toHaveBeenCalled();
  });
});

describe('OData snapshot transport compatibility', () => {
  it('preserves v3 record ETags while ignoring URI/type transport differences', async () => {
    const env = setupMerge({ references: 1 });
    env.odataClient.getRecord.mockImplementation(async (collection, id) => {
      const record = { ...env.records.get(`${collection}:${id}`)! };
      const etag = record['@odata.etag'];
      delete record['@odata.etag'];
      return {
        ...record,
        __metadata: {
          uri: `https://crm.example.test/entity/${collection}/${id}`,
          type: `Model.${collection}`,
          etag,
        },
      };
    });
    const result = await env.confirm({ keep_duplicates: true });
    expect(result.isError).toBe(false);
    expect(env.odataClient.updateRecord).toHaveBeenCalledWith(
      'Activity',
      REF_1,
      { ContactId: MASTER },
      { expectedEtag: 'W/"1"' }
    );
  });
  it('still rejects changed v3 ETags even when only transport URIs otherwise differ', async () => {
    const env = setupMerge({ references: 1 });
    const record = { ...env.records.get(`Activity:${REF_1}`)! };
    delete record['@odata.etag'];
    record.__metadata = { uri: 'https://crm.example.test/collection-row', etag: 'W/"1"' };
    env.records.set(`Activity:${REF_1}`, record);
    const args = { ...env.args, keep_duplicates: true };
    const preview = await env.handler(args);
    env.records.set(`Activity:${REF_1}`, {
      ...record,
      __metadata: { uri: 'https://crm.example.test/entity-row', etag: 'W/"2"' },
    });
    const result = await env.handler({
      ...args,
      confirm: true,
      expected_references: 1,
      confirmation_token: preview.structuredContent?.confirmation_token,
    });
    expect(result.isError).toBe(true);
    expect(env.odataClient.updateRecord).not.toHaveBeenCalled();
    expect(env.odataClient.deleteRecord).not.toHaveBeenCalled();
  });
  it('executes the real MCP handler and HTTP pipeline when entity reads add @odata.context', async () => {
    const config = buildConfig('https://crm.example.test', undefined, undefined, {
      platform: 'net8',
      odata_version: 4,
    });
    const http = new HttpClient(config);
    http.setAllowEnvCreds(true);
    http.updateAuthState({ isAuthenticated: true, csrfToken: 'test-token' });
    const odataClient = new ODataClient(config, http);
    let contactId = DUP;
    const writes: Row[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (address: string, request: RequestInit) => {
        const url = new URL(address);
        const path = url.pathname.split('/').pop()!;
        if (request.method === 'PATCH') {
          const data = JSON.parse(String(request.body)) as Row;
          writes.push(data);
          contactId = String(data.ContactId);
          return new Response(null, { status: 204 });
        }
        const context = `https://crm.example.test/odata/$metadata#${path}/$entity`;
        if (path === `Contact(${MASTER})`)
          return Response.json({ '@odata.context': context, Id: MASTER, Name: 'Master', Email: '' });
        if (path === `Contact(${DUP})`)
          return Response.json({ '@odata.context': context, Id: DUP, Name: 'Duplicate', Email: '' });
        if (path === `Activity(${REF_1})`)
          return Response.json({
            '@odata.context': context,
            Id: REF_1,
            Title: 'Fixture activity',
            ContactId: contactId,
          });
        if (path === 'Activity')
          return Response.json({
            '@odata.context': 'https://crm.example.test/odata/$metadata#Activity',
            value: [{ Id: REF_1, Title: 'Fixture activity', ContactId: contactId }],
            '@odata.count': 1,
          });
        throw new Error('Unexpected fixture route ' + url.pathname);
      })
    );
    const graph = new Map([['Contact', [{ from: 'Activity', field: 'ContactId', nav: 'Contact' }]]]);
    const services = {
      initialized: true,
      config,
      odataClient,
      authManager: { ensureAuthenticated: async () => undefined },
      metadataManager: {
        resolveCollectionReference: async (name: string) => ({ name }),
        getEntityMetadata: async () => CONTACT,
        getLookupGraph: async () => ({ incoming: graph, outgoing: new Map() }),
        getEntitySets: async () => [],
      },
      lookupResolver: { resolve: async () => ({ resolved: false, matchCount: 0, candidates: [] }) },
    } as unknown as ServiceContainer;
    const server = new McpServer({ name: 'merge-context-test', version: '0.0.0' });
    registerDedupTools(server, services);
    const client = new Client({ name: 'merge-context-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const args = {
        collection: 'Contact',
        master_id: MASTER,
        duplicate_ids: [DUP],
        keep_duplicates: true,
        fill_empty_fields: false,
        max_references: 5,
      };
      const preview = await client.callTool({ name: 'bpm_merge_duplicates', arguments: args });
      expect(preview.isError).toBeFalsy();
      expect(writes).toHaveLength(0);
      const plan = preview.structuredContent as Row;
      const result = await client.callTool({
        name: 'bpm_merge_duplicates',
        arguments: {
          ...args,
          confirm: true,
          expected_references: plan.expected_references,
          confirmation_token: plan.confirmation_token,
        },
      });
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({
        outcomes: [
          { step: 'repoint', collection: 'Activity', id: REF_1, fields: ['ContactId'], state: 'succeeded' },
        ],
        result: { repointed: 1, deleted: [], kept: [DUP] },
      });
      expect(writes).toEqual([{ ContactId: MASTER }]);
      expect(contactId).toBe(MASTER);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
