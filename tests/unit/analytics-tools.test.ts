import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerDedupTools } from '../../src/tools/dedup-tools.js';
import { registerAnalyticsTools } from '../../src/tools/analytics-tools.js';
import { MetadataManager } from '../../src/metadata/metadata-manager.js';
import { ODataClient } from '../../src/client/odata-client.js';
import { LookupResolver } from '../../src/lookup/lookup-resolver.js';
import type { BpmConfig } from '../../src/types/index.js';
import type { ServiceContainer } from '../../src/tools/init-tool.js';
import { MockHttpClient } from '../setup/mock-http-client.js';

const config: BpmConfig = {
  bpmsoft_url: 'https://bpm.test',
  odata_version: 4,
  platform: 'net8',
  page_size: 100,
  max_batch_size: 100,
  lookup_cache_ttl: 300,
  request_timeout: 30000,
  max_file_size: 1000,
};
const cityId = '11111111-1111-1111-1111-111111111111';
const xml = `<edmx:Edmx><edmx:DataServices><Schema Namespace="BPMSoft">
  <EntityType Name="Contact"><Property Name="Id" Type="Edm.Guid"/><Property Name="Name" Type="Edm.String"/>
    <Property Name="Email" Type="Edm.String"/><Property Name="Phone" Type="Edm.String"/>
    <Property Name="Amount" Type="Edm.Decimal"/><Property Name="BigInteger" Type="Edm.Int64"/>
    <Property Name="CreatedOn" Type="Edm.DateTimeOffset"/><Property Name="BirthDate" Type="Edm.Date"/>
    <Property Name="AtTime" Type="Edm.TimeOfDay"/>
    <Property Name="OwnerId" Type="Edm.Guid"/><NavigationProperty Name="Owner" Type="BPMSoft.Contact"/>
    <Property Name="CityId" Type="Edm.Guid"/><NavigationProperty Name="City" Type="BPMSoft.City"/></EntityType>
  <EntityType Name="City"><Property Name="Id" Type="Edm.Guid"/><Property Name="Name" Type="Edm.String"/></EntityType>
  <EntityContainer><EntitySet Name="Contact" EntityType="BPMSoft.Contact"/><EntitySet Name="City" EntityType="BPMSoft.City"/></EntityContainer>
</Schema></edmx:DataServices></edmx:Edmx>`;
type RecordData = Record<string, unknown>;

function setup(
  records: RecordData[],
  countAvailable = true,
  serverPageSize = 2,
  user?: { contactId: string; timeZoneId: string }
) {
  const http = new MockHttpClient();
  http.setFallback((request) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith('$metadata')) return { data: xml };
    if (url.pathname.endsWith('/City')) return { data: { value: [{ Id: cityId, Name: 'Москва' }] } };
    const filter = url.searchParams.get('$filter') || '';
    const nameMatch = /Name eq '((?:[^']|'')*)'/.exec(filter);
    const selected = nameMatch
      ? records.filter((record) => record.Name === nameMatch[1].replaceAll("''", "'"))
      : records;
    const skip = Number(url.searchParams.get('$skip') || 0);
    const top = Number(url.searchParams.get('$top') || 100);
    const page = selected.slice(skip, skip + Math.min(top, serverPageSize));
    const hasNext = skip + page.length < selected.length && page.length < top;
    const next = new URL(url);
    next.searchParams.set('$skip', String(skip + page.length));
    next.searchParams.set('$top', String(top - page.length));
    return {
      data: {
        value: page,
        ...(countAvailable ? { '@odata.count': selected.length } : {}),
        ...(hasNext ? { '@odata.nextLink': next.toString() } : {}),
      },
    };
  });
  const odataClient = new ODataClient(config, http as never);
  const metadataManager = new MetadataManager(config, odataClient);
  const services = {
    config,
    odataClient,
    metadataManager,
    authManager: { async ensureAuthenticated() {} },
    ...(user ? { currentUser: { get: async () => user } } : {}),
    lookupResolver: new LookupResolver(config, odataClient, metadataManager),
    initialized: true,
  } as ServiceContainer;
  const tools = new Map<
    string,
    {
      definition: { inputSchema: z.ZodRawShape; outputSchema: z.ZodRawShape };
      handler: (args: RecordData) => Promise<CallToolResult>;
    }
  >();
  const server = {
    registerTool(
      name: string,
      definition: { inputSchema: z.ZodRawShape; outputSchema: z.ZodRawShape },
      handler: (args: RecordData) => Promise<CallToolResult>
    ) {
      tools.set(name, { definition, handler });
    },
  } as never;
  registerAnalyticsTools(server, services);
  registerDedupTools(server, services);
  const call = async (name: string, args: RecordData = {}) => {
    const tool = tools.get(name)!;
    const result = await tool.handler(
      z.object(tool.definition.inputSchema).parse({ collection: 'Contact', ...args })
    );
    if (!result.isError) z.object(tool.definition.outputSchema).parse(result.structuredContent);
    return result;
  };
  return { call, http, tools };
}

describe('server analytics real registered handlers', () => {
  it('resolves @me through the authenticated user rather than a literal lookup search', async () => {
    const contactId = '22222222-2222-2222-2222-222222222222';
    const { call, http } = setup([{ Id: 'a', Amount: '1' }], true, 2, {
      contactId,
      timeZoneId: 'Europe/Moscow',
    });
    const result = await call('bpm_aggregate_records', {
      criteria: [{ field: 'Owner', op: 'eq', value: '@me' }],
      metrics: [{ field: 'Amount', op: 'sum' }],
    });
    expect(result.isError).toBeUndefined();
    const requests = http.requests.filter((request) => new URL(request.url).pathname.endsWith('/Contact'));
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0].url).searchParams.get('$filter')).toBe(`Owner/Id eq ${contactId}`);
    expect(result.structuredContent).toMatchObject({
      complete: true,
      scanned_count: 1,
      groups: [{ count: 1, metrics: { sum_Amount: '1' } }],
    });
  });
  it('compiles whole-day criteria in the user timezone instead of the server timezone', async () => {
    vi.stubEnv('BPMSOFT_TIMEZONE', 'UTC');
    try {
      const { call, http } = setup([{ Id: 'a', Amount: '1' }], true, 2, {
        contactId: '22222222-2222-2222-2222-222222222222',
        timeZoneId: 'Europe/Moscow',
      });
      const result = await call('bpm_aggregate_records', {
        criteria: [{ field: 'CreatedOn', op: 'eq', value: '2026-09-23' }],
      });
      expect(result.isError).toBeUndefined();
      const request = http.requests.find((item) => new URL(item.url).pathname.endsWith('/Contact'))!;
      expect(new URL(request.url).searchParams.get('$filter')).toBe(
        'CreatedOn ge 2026-09-22T21:00:00Z and CreatedOn lt 2026-09-23T21:00:00Z'
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('does not fetch user timezone for null checks or explicit-offset instants', async () => {
    const { call, http } = setup([{ Id: 'a', CreatedOn: '2026-10-07T00:00:00Z', Amount: '1' }]);
    const result = await call('bpm_aggregate_records', {
      criteria: [
        { field: 'CreatedOn', op: 'is_null' },
        { field: 'CreatedOn', op: 'eq', value: '2026-10-07T00:00:00Z' },
      ],
      metrics: [{ field: 'Amount', op: 'sum' }],
    });
    expect(result.isError).toBeUndefined();
    const request = http.requests.find((item) => new URL(item.url).pathname.endsWith('/Contact'))!;
    expect(new URL(request.url).searchParams.get('$filter')).toContain('CreatedOn eq null');
    expect(new URL(request.url).searchParams.get('$filter')).toContain('CreatedOn eq 2026-10-07T00:00:00Z');
  });
  it('requires a trusted timezone for calendar criteria', async () => {
    const { call } = setup([{ Id: 'a', CreatedOn: '2026-10-07T00:00:00Z', Amount: '1' }]);
    const result = await call('bpm_aggregate_records', {
      criteria: [{ field: 'CreatedOn', op: 'today' }],
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('timezone cannot be verified');
  });
  it('uses one captured UTC instant for elapsed windows without requiring user identity', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-07T12:00:00Z'));
    try {
      const { call, http } = setup([{ Id: 'a', CreatedOn: '2026-10-07T00:00:00Z', Amount: '1' }]);
      const result = await call('bpm_aggregate_records', {
        criteria: [{ field: 'CreatedOn', op: 'in_last_days', value: 7 }],
      });
      expect(result.isError).toBeUndefined();
      const request = http.requests.find((item) => new URL(item.url).pathname.endsWith('/Contact'))!;
      expect(new URL(request.url).searchParams.get('$filter')).toBe('CreatedOn ge 2026-09-30T12:00:00Z');
    } finally {
      vi.useRealTimers();
    }
  });
  it('computes monetary and Int64 metrics exactly across backend pages', async () => {
    const { call } = setup([
      { Id: 'a', Amount: '9007199254740993.01', BigInteger: '9007199254740993' },
      { Id: 'b', Amount: '0.09', BigInteger: '9007199254740994' },
    ]);
    const result = await call('bpm_aggregate_records', {
      metrics: [
        { field: 'Amount', op: 'sum' },
        { field: 'Amount', op: 'avg' },
        { field: 'BigInteger', op: 'sum' },
      ],
    });
    expect(result.structuredContent).toMatchObject({
      complete: true,
      scanned_count: 2,
      total_count: 2,
      numeric_encoding: 'decimal_string',
      avg_precision: 6,
      groups: [
        {
          count: 2,
          metrics: {
            sum_Amount: '9007199254740993.1',
            avg_Amount: '4503599627370496.550000',
            sum_BigInteger: '18014398509481987',
          },
        },
      ],
    });
  });
  it('compares named cohorts with exact derived deltas, percent changes and sum shares', async () => {
    const { call } = setup([
      { Id: 'a1', Name: 'baseline', Email: 'x', Amount: '10' },
      { Id: 'a2', Name: 'baseline', Email: 'y', Amount: '5' },
      { Id: 'b1', Name: 'new', Email: 'x', Amount: '15' },
      { Id: 'b2', Name: 'new', Email: 'y', Amount: '0' },
    ]);
    const result = await call('bpm_aggregate_records', {
      group_by: ['Email'],
      metrics: [{ field: 'Amount', op: 'sum', alias: 'amount' }],
      cohorts: [
        { label: 'baseline', criteria: [{ field: 'Name', op: 'eq', value: 'baseline' }] },
        { label: 'new', criteria: [{ field: 'Name', op: 'eq', value: 'new' }] },
      ],
      compare: { baseline: 'baseline', comparison: 'new' },
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      complete: true,
      cohort_coverage: [
        { label: 'baseline', scanned_count: 2, total_count: 2 },
        { label: 'new', scanned_count: 2, total_count: 2 },
      ],
      groups: [
        {
          dimensions: { Email: 'x' },
          cohort_results: { baseline: { metrics: { amount: '10' } }, new: { metrics: { amount: '15' } } },
          derived_metrics: {
            amount: {
              difference: '5',
              percent_change: '50',
              baseline_share: '66.666667',
              comparison_share: '100',
            },
          },
        },
        {
          dimensions: { Email: 'y' },
          cohort_results: { baseline: { metrics: { amount: '5' } }, new: { metrics: { amount: '0' } } },
          derived_metrics: {
            amount: {
              difference: '-5',
              percent_change: '-100',
              baseline_share: '33.333333',
              comparison_share: '0',
            },
          },
        },
      ],
    });
  });
  it('marks derived cohort results partial when either scan is capped', async () => {
    const { call } = setup([
      { Id: 'a1', Name: 'baseline', Email: 'x', Amount: '10' },
      { Id: 'a2', Name: 'baseline', Email: 'y', Amount: '5' },
      { Id: 'b1', Name: 'new', Email: 'x', Amount: '15' },
      { Id: 'b2', Name: 'new', Email: 'y', Amount: '0' },
    ]);
    const result = await call('bpm_aggregate_records', {
      group_by: ['Email'],
      metrics: [{ field: 'Amount', op: 'sum' }],
      max_records: 1,
      cohorts: [
        { label: 'baseline', criteria: [{ field: 'Name', op: 'eq', value: 'baseline' }] },
        { label: 'new', criteria: [{ field: 'Name', op: 'eq', value: 'new' }] },
      ],
      compare: { baseline: 'baseline', comparison: 'new' },
    });
    expect(result.structuredContent).toMatchObject({
      complete: false,
      groups: [{ derived_metrics: { sum_Amount: { partial: true } } }],
    });
  });
  it('keeps cohort and metric labels collision-safe when calculating sum shares', async () => {
    const { call } = setup([
      { Id: 'a1', Name: 'a:b', Email: 'x', Amount: '1', BigInteger: '100' },
      { Id: 'a2', Name: 'a:b', Email: 'y', Amount: '9', BigInteger: '300' },
      { Id: 'b1', Name: 'a', Email: 'x', Amount: '9', BigInteger: '900' },
      { Id: 'b2', Name: 'a', Email: 'y', Amount: '1', BigInteger: '100' },
    ]);
    const result = await call('bpm_aggregate_records', {
      group_by: ['Email'],
      metrics: [
        { field: 'Amount', op: 'sum', alias: 'c' },
        { field: 'BigInteger', op: 'sum', alias: 'b:c' },
      ],
      cohorts: [
        { label: 'a:b', criteria: [{ field: 'Name', op: 'eq', value: 'a:b' }] },
        { label: 'a', criteria: [{ field: 'Name', op: 'eq', value: 'a' }] },
      ],
      compare: { baseline: 'a:b', comparison: 'a' },
    });
    expect(result.structuredContent).toMatchObject({
      groups: [
        {
          dimensions: { Email: 'x' },
          derived_metrics: {
            c: { baseline_share: '10', comparison_share: '90' },
            'b:c': { baseline_share: '25', comparison_share: '90' },
          },
        },
        {
          dimensions: { Email: 'y' },
          derived_metrics: {
            c: { baseline_share: '90', comparison_share: '10' },
            'b:c': { baseline_share: '75', comparison_share: '10' },
          },
        },
      ],
    });
  });
  it('accepts special cohort labels without changing object prototypes', async () => {
    const { call } = setup([{ Id: 'a', Name: 'baseline', Email: 'x', Amount: '1' }]);
    const result = await call('bpm_aggregate_records', {
      metrics: [{ field: 'Amount', op: 'sum' }],
      cohorts: [
        { label: '__proto__', criteria: [{ field: 'Name', op: 'eq', value: 'baseline' }] },
        { label: 'constructor', criteria: [{ field: 'Name', op: 'eq', value: 'baseline' }] },
      ],
      compare: { baseline: '__proto__', comparison: 'constructor' },
    });
    expect(result.isError).toBeUndefined();
    expect(
      Object.keys(
        (result.structuredContent as { groups: Array<{ cohort_results: object }> }).groups[0].cohort_results
      )
    ).toEqual(['__proto__', 'constructor']);
  });
  it('reports zero-baseline percentage and share denominators explicitly', async () => {
    const { call } = setup([
      { Id: 'a', Name: 'baseline', Amount: '0' },
      { Id: 'b', Name: 'new', Amount: '2' },
    ]);
    const result = await call('bpm_aggregate_records', {
      metrics: [{ field: 'Amount', op: 'sum' }],
      cohorts: [
        { label: 'baseline', criteria: [{ field: 'Name', op: 'eq', value: 'baseline' }] },
        { label: 'new', criteria: [{ field: 'Name', op: 'eq', value: 'new' }] },
      ],
      compare: { baseline: 'baseline', comparison: 'new' },
    });
    expect(result.structuredContent).toMatchObject({
      groups: [
        {
          derived_metrics: {
            sum_Amount: {
              difference: '2',
              percent_change: null,
              baseline_share: null,
              comparison_share: '100',
              null_reasons: {
                percent_change: 'baseline_zero',
                baseline_share: 'zero_or_missing_cohort_total',
              },
            },
          },
        },
      ],
    });
  });
  it('hydrates lookup groups while preserving original identifier dimensions', async () => {
    const { call } = setup([
      { Id: 'a', CityId: cityId, Amount: '0.1' },
      { Id: 'b', CityId: cityId, Amount: '0.2' },
    ]);
    const result = await call('bpm_aggregate_records', {
      group_by: ['City'],
      metrics: [{ field: 'Amount', op: 'sum' }],
    });
    expect(result.structuredContent!.groups).toMatchObject([
      {
        dimensions: { CityId: cityId },
        display_dimensions: { CityId: 'Москва' },
        count: 2,
        metrics: { sum_Amount: '0.3' },
      },
    ]);
  });
  it('marks scan limits as partial even when $top suppresses the next link', async () => {
    const { call } = setup(
      [
        { Id: 'a', Amount: '1' },
        { Id: 'b', Amount: '2' },
        { Id: 'c', Amount: '1000' },
      ],
      true,
      10
    );
    const result = await call('bpm_aggregate_records', {
      max_records: 2,
      metrics: [{ field: 'Amount', op: 'sum' }],
    });
    expect(result.structuredContent).toMatchObject({
      complete: false,
      scanned_count: 2,
      total_count: 3,
      has_more: true,
      groups: [{ metrics: { sum_Amount: '3' } }],
    });
    expect(String(result.content[0].type === 'text' ? result.content[0].text : '')).toContain(
      'Частичная выборка'
    );
  });
  it('does not invent a total count when the backend cannot provide one', async () => {
    const { call } = setup([{ Id: 'a' }, { Id: 'b' }], false, 10);
    const result = await call('bpm_aggregate_records');
    expect(result.structuredContent!.total_count).toBeUndefined();
    expect(result.structuredContent!.complete).toBe(true);
  });
  it('returns a meaningful zero-record aggregate with null metrics', async () => {
    const { call } = setup([]);
    const result = await call('bpm_aggregate_records', { metrics: [{ field: 'Amount', op: 'sum' }] });
    expect(result.structuredContent).toMatchObject({
      complete: true,
      scanned_count: 0,
      groups: [{ count: 0, metrics: { sum_Amount: null }, metric_counts: { sum_Amount: 0 } }],
    });
  });
  it('validates numeric field types before scanning', async () => {
    const { call, http } = setup([{ Id: 'a', Name: '3' }]);
    const result = await call('bpm_aggregate_records', { metrics: [{ field: 'Name', op: 'sum' }] });
    expect(result.isError).toBe(true);
    expect(result.structuredContent!.code).toBe('validation');
    expect(
      http.requests.filter((request) => new URL(request.url).pathname.endsWith('/Contact'))
    ).toHaveLength(0);
  });
  it('ignores null measurements, handles negative min/max and rounds averages explicitly', async () => {
    const { call } = setup([
      { Id: 'a', Amount: '-1' },
      { Id: 'b', Amount: '0' },
      { Id: 'c', Amount: '0' },
      { Id: 'd', Amount: null },
    ]);
    const result = await call('bpm_aggregate_records', {
      metrics: ['sum', 'avg', 'min', 'max'].map((op) => ({ field: 'Amount', op })),
    });
    expect(result.structuredContent!.groups).toMatchObject([
      {
        count: 4,
        metric_counts: { avg_Amount: 3 },
        metrics: { sum_Amount: '-1', avg_Amount: '-0.333333', min_Amount: '-1', max_Amount: '0' },
      },
    ]);
  });
  it('reports group clipping independently of data completeness', async () => {
    const { call } = setup([
      { Id: 'a', Name: 'A' },
      { Id: 'b', Name: 'B' },
    ]);
    const result = await call('bpm_aggregate_records', { group_by: ['Name'], max_groups: 1 });
    expect(result.structuredContent).toMatchObject({
      complete: true,
      truncated_groups: true,
      observed_group_count: 2,
    });
    expect((result.structuredContent!.groups as unknown[]).length).toBe(1);
  });
  it('rejects ambiguous aliases and unknown dimensions', async () => {
    const { call } = setup([]);
    expect(
      (
        await call('bpm_aggregate_records', {
          metrics: [
            { field: 'Amount', op: 'sum', alias: 'x' },
            { field: 'Amount', op: 'avg', alias: 'x' },
          ],
        })
      ).isError
    ).toBe(true);
    expect((await call('bpm_aggregate_records', { group_by: ['DoesNotExist'] })).isError).toBe(true);
  });
  it('advertises rank and date parameters only on aggregate analytics', () => {
    const { tools } = setup([]);
    expect(tools.get('bpm_aggregate_records')!.definition.inputSchema).toHaveProperty('rank_by');
    expect(tools.get('bpm_find_duplicates')!.definition.inputSchema).not.toHaveProperty('rank_by');
    expect(tools.get('bpm_find_duplicates')!.definition.inputSchema).not.toHaveProperty('date_field');
  });
  it('ranks decimal metrics exactly and applies max_groups after ranking', async () => {
    const { call } = setup([
      { Id: 'a', Name: 'A', Amount: '9007199254740993.01' },
      { Id: 'b', Name: 'B', Amount: '9007199254740993.02' },
      { Id: 'c', Name: 'C', Amount: null },
      { Id: 'd', Name: 'D', Amount: '9007199254740993.02' },
    ]);
    const result = await call('bpm_aggregate_records', {
      group_by: ['Name'],
      metrics: [{ field: 'Amount', op: 'sum', alias: 'exact' }],
      rank_by: 'exact',
      rank_direction: 'desc',
      max_groups: 2,
    });
    expect(result.structuredContent).toMatchObject({ ranking_scope: 'global', truncated_groups: true });
    expect(result.structuredContent!.groups).toMatchObject([
      { dimensions: { Name: 'B' }, metrics: { exact: '9007199254740993.02' } },
      { dimensions: { Name: 'D' }, metrics: { exact: '9007199254740993.02' } },
    ]);
  });
  it('places null metric values last in ascending order and identifies partial ranking', async () => {
    const { call } = setup([
      { Id: 'a', Name: 'A', Amount: null },
      { Id: 'b', Name: 'B', Amount: '2' },
      { Id: 'c', Name: 'C', Amount: '1' },
    ]);
    const result = await call('bpm_aggregate_records', {
      group_by: ['Name'],
      metrics: [{ field: 'Amount', op: 'sum', alias: 'm' }],
      rank_by: 'm',
      rank_direction: 'asc',
      max_records: 2,
    });
    expect(result.structuredContent).toMatchObject({ ranking_scope: 'observed_scan', complete: false });
    expect(result.structuredContent!.groups).toMatchObject([
      { dimensions: { Name: 'B' }, metrics: { m: '2' } },
      { dimensions: { Name: 'A' }, metrics: { m: null } },
    ]);
  });
  it('rejects malformed rank and date arguments before fetching records', async () => {
    const { call, http } = setup([{ Id: 'a', Amount: '1' }]);
    for (const args of [
      { rank_by: 'unknown' },
      { rank_direction: 'asc' },
      { date_field: 'CreatedOn' },
      { bucket: 'week' },
      { date_field: 'AtTime', bucket: 'day' },
    ]) {
      const before = http.requests.filter((request) =>
        new URL(request.url).pathname.endsWith('/Contact')
      ).length;
      expect((await call('bpm_aggregate_records', args)).isError).toBe(true);
      const after = http.requests.filter((request) =>
        new URL(request.url).pathname.endsWith('/Contact')
      ).length;
      expect(after).toBe(before);
    }
  });
  it('groups categorical and date dimensions independently across a Monday and DST boundary', async () => {
    const { call, http } = setup(
      [
        { Id: 'a', Name: 'X', CreatedOn: '2026-03-29T00:30:00Z' },
        { Id: 'b', Name: 'X', CreatedOn: '2026-03-30T00:30:00Z' },
      ],
      true,
      2,
      { contactId: cityId, timeZoneId: 'Europe/Berlin' }
    );
    const result = await call('bpm_aggregate_records', {
      group_by: ['Name'],
      date_field: 'CreatedOn',
      bucket: 'week',
    });
    expect(result.structuredContent!.groups).toMatchObject([
      { dimensions: { Name: 'X', bucket_CreatedOn: 'неделя с 2026-03-23' }, count: 1 },
      { dimensions: { Name: 'X', bucket_CreatedOn: 'неделя с 2026-03-30' }, count: 1 },
    ]);
    const request = http.requests.find((item) => new URL(item.url).pathname.endsWith('/Contact'))!;
    expect(new URL(request.url).searchParams.get('$select')).not.toContain('bucket_CreatedOn');
  });
  it('keeps Edm.Date calendar days independent of timezone conversion', async () => {
    const { call } = setup([{ Id: 'a', BirthDate: '2026-01-01' }], true, 2, {
      contactId: cityId,
      timeZoneId: 'America/Los_Angeles',
    });
    const result = await call('bpm_aggregate_records', { date_field: 'BirthDate', bucket: 'day' });
    expect(result.structuredContent!.groups).toMatchObject([
      { dimensions: { bucket_BirthDate: '2026-01-01' }, count: 1 },
    ]);
  });
  it('uses calendar month labels for date buckets', async () => {
    const { call } = setup([{ Id: 'a', CreatedOn: '2026-12-31T23:30:00Z' }], true, 2, {
      contactId: cityId,
      timeZoneId: 'Europe/Moscow',
    });
    const result = await call('bpm_aggregate_records', { date_field: 'CreatedOn', bucket: 'month' });
    expect(result.structuredContent!.groups).toMatchObject([
      { dimensions: { bucket_CreatedOn: '2027-01' }, count: 1 },
    ]);
  });
});

describe('duplicate candidate analysis', () => {
  it('normalizes email keys and excludes missing keys', async () => {
    const { call } = setup([
      { Id: 'a', Email: ' Alice@EXAMPLE.test ' },
      { Id: 'b', Email: 'alice@example.test' },
      { Id: 'c', Email: '' },
      { Id: 'd', Email: null },
    ]);
    const result = await call('bpm_find_duplicates', { fields: ['Email'] });
    expect(result.structuredContent).toMatchObject({
      complete: true,
      scanned_count: 4,
      observed_group_count: 1,
      observed_duplicate_records: 2,
      groups: [
        {
          count: 2,
          normalized_key: { Email: 'alice@example.test' },
          record_ids: ['a', 'b'],
          record_ids_truncated: false,
        },
      ],
    });
  });
  it('normalizes legal forms/names and phone punctuation for joint keys', async () => {
    const { call } = setup([
      { Id: 'a', Name: 'АО «ЛАНИТ»', Phone: '+7 (123) 456-78-90' },
      { Id: 'b', Name: 'Ланит', Phone: '71234567890' },
      { Id: 'c', Name: 'Ланит', Phone: '70000000000' },
    ]);
    const result = await call('bpm_find_duplicates', { fields: ['Name', 'Phone'] });
    expect(result.structuredContent!.groups).toMatchObject([
      { count: 2, normalized_key: { Name: 'ланит', Phone: '71234567890' }, record_ids: ['a', 'b'] },
    ]);
  });
  it('does not label a partial no-match scan as exhaustive absence of duplicates', async () => {
    const { call } = setup([
      { Id: 'a', Name: 'A' },
      { Id: 'b', Name: 'B' },
      { Id: 'c', Name: 'A' },
    ]);
    const result = await call('bpm_find_duplicates', { fields: ['Name'], max_records: 2 });
    expect(result.structuredContent).toMatchObject({
      complete: false,
      has_more: true,
      observed_group_count: 0,
      groups: [],
    });
  });
  it('preserves observed duplicate counts when returned ids and groups are bounded', async () => {
    const rows = Array.from({ length: 25 }, (_, index) => ({ Id: `a-${index}`, Name: 'Same' })).concat([
      { Id: 'b-1', Name: 'Other' },
      { Id: 'b-2', Name: 'Other' },
    ]);
    const { call } = setup(rows);
    const result = await call('bpm_find_duplicates', { fields: ['Name'], max_groups: 1 });
    expect(result.structuredContent).toMatchObject({
      observed_group_count: 2,
      observed_duplicate_records: 27,
      truncated_groups: true,
      groups: [{ count: 25, record_ids_truncated: true }],
    });
    const group = (
      result.structuredContent!.groups as Array<{ record_ids: string[]; sample_records: unknown[] }>
    )[0];
    expect(group.record_ids).toHaveLength(20);
    expect(group.sample_records).toHaveLength(5);
  });
});
