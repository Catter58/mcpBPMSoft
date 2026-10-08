import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { initializeServices } from '../../src/tools/init-tool.js';
import { createToolServer } from '../../src/server/tool-server.js';
import { runWithAuth } from '../../src/auth/request-context.js';
import { createSyntheticSession, recordId, TARGET_NAME } from '../../scripts/lib/context-budget.mjs';

const RESPONSE_LIMIT = 64 * 1024;
const runtime = { initializeServices, createToolServer, runWithAuth };
let session: Awaited<ReturnType<typeof createSyntheticSession>>;

beforeAll(async () => {
  vi.stubEnv('BPMSOFT_METADATA_CACHE', 'off');
  session = await createSyntheticSession({}, runtime);
});

afterAll(async () => {
  await session?.close();
  vi.unstubAllEnvs();
});

describe('100000-row OData collection through the production MCP server', () => {
  it('validates published schemas and preserves bounded default pagination', async () => {
    const tool = session.tools.find((item) => item.name === 'bpm_get_records');
    expect(tool?.outputSchema).toBeDefined();
    const { result, metrics } = await session.call('bpm_get_records', {
      collection: 'Contact',
      count: true,
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      count: 20,
      total_count: 100000,
      has_more: true,
    });
    expect(result.structuredContent.records[0].Id).toBe(recordId(1));
    expect(result.structuredContent.records.at(-1).Id).toBe(recordId(20));
    expect(result.structuredContent.cursor).toEqual(expect.any(String));
    expect(metrics.result_bytes).toBeLessThanOrEqual(RESPONSE_LIMIT);
    expect(metrics.data_request_count).toBe(1);
    expect(metrics.fetched_rows).toBe(21);
  });

  it('respects a backend page of 200 even when top is 1000', async () => {
    const { result, metrics } = await session.call('bpm_get_records', {
      collection: 'Contact',
      top: 1000,
      format: 'compact',
      count: true,
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      count: 200,
      total_count: 100000,
      has_more: true,
    });
    expect(metrics.returned_rows).toBeLessThanOrEqual(1000);
    expect(metrics.result_bytes).toBeLessThanOrEqual(RESPONSE_LIMIT);
    expect(metrics.data_request_count).toBe(1);
    expect(metrics.fetched_rows).toBe(200);
  });

  it('finds a selective match at row 100000 without exporting preceding rows', async () => {
    const { result, metrics } = await session.call('bpm_search_records', {
      collection: 'Contact',
      criteria: [{ field: 'Name', op: 'eq', value: TARGET_NAME }],
      select: 'Id,Name,Email',
      count: true,
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ count: 1, total_count: 1, has_more: false });
    expect(result.structuredContent.records).toEqual([
      expect.objectContaining({ Id: recordId(100000), Name: TARGET_NAME }),
    ]);
    expect(metrics.data_request_count).toBe(1);
    expect(metrics.fetched_rows).toBe(1);
    expect(metrics.result_bytes).toBeLessThanOrEqual(RESPONSE_LIMIT);
  });

  it.each([5000, 20000])('reports partial aggregation after scanning %i rows', async (limit) => {
    const { result, metrics } = await session.call('bpm_aggregate_records', {
      collection: 'Contact',
      group_by: ['Category'],
      metrics: [{ field: 'Amount', op: 'sum', alias: 'total_amount' }],
      ...(limit === 20000 ? { max_records: limit } : {}),
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      scanned_count: limit,
      total_count: 100000,
      complete: false,
      has_more: true,
      numeric_encoding: 'decimal_string',
    });
    const groups = result.structuredContent.groups as Array<{ count: number }>;
    expect(groups.reduce((sum, group) => sum + group.count, 0)).toBe(limit);
    expect(metrics.fetched_rows).toBe(limit + 1);
    expect(metrics.data_request_count).toBe(Math.ceil((limit + 1) / 200));
    expect(metrics.result_bytes).toBeLessThanOrEqual(RESPONSE_LIMIT);
  });

  it('computes a complete exact decimal aggregate after narrowing the filter', async () => {
    const { result, metrics } = await session.call('bpm_aggregate_records', {
      collection: 'Contact',
      group_by: ['Category'],
      metrics: [{ field: 'Amount', op: 'sum', alias: 'total_amount' }],
      criteria: [{ field: 'Category', op: 'eq', value: 'Narrow' }],
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      scanned_count: 200,
      total_count: 200,
      complete: true,
      has_more: false,
      groups: [expect.objectContaining({ count: 200, metrics: { total_amount: '20150' } })],
    });
    expect(metrics.data_request_count).toBe(1);
    expect(metrics.fetched_rows).toBe(200);
    expect(metrics.result_bytes).toBeLessThanOrEqual(RESPONSE_LIMIT);
  });

  it('counts all 100000 rows without fetching record data', async () => {
    const { result, metrics } = await session.call('bpm_count_records', { collection: 'Contact' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.count).toBe(100000);
    expect(metrics.data_request_count).toBe(0);
    expect(metrics.count_request_count).toBe(1);
    expect(metrics.fetched_rows).toBe(0);
    expect(metrics.result_bytes).toBeLessThanOrEqual(RESPONSE_LIMIT);
  });

  it('returns byte-bounded auto-pages and continues exactly once through cursor-only calls', async () => {
    let cursor: string | undefined;
    const delivered: string[] = [];
    for (let page = 0; page < 3; page++) {
      const { result, metrics } = await session.call(
        'bpm_get_records',
        cursor
          ? { cursor }
          : {
              collection: 'Contact',
              select: 'Id,Name,Email,Amount,Category',
              auto_paginate: true,
              max_records: 1000,
              format: 'full',
              count: true,
            }
      );
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ total_count: 100000, has_more: true });
      expect(metrics.result_bytes).toBeLessThanOrEqual(RESPONSE_LIMIT);
      const ids = result.structuredContent.records.map((record: { Id: string }) => record.Id);
      expect(metrics.data_request_count).toBeGreaterThanOrEqual(1);
      expect(metrics.fetched_rows).toBeGreaterThanOrEqual(ids.length);
      expect(metrics.fetched_rows).toBeLessThanOrEqual(1000);
      expect(ids.length).toBeGreaterThan(0);
      delivered.push(...ids);
      cursor = result.structuredContent.cursor;
      expect(cursor).toEqual(expect.any(String));
    }
    expect(delivered).toEqual(delivered.map((_, index) => recordId(index + 1)));

    const { result, metrics } = await session.call('bpm_get_records', {
      collection: 'Contact',
      top: 20,
      select: '*',
      format: 'full',
      count: true,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      success: false,
      code: 'response_too_large',
      response_limit_bytes: RESPONSE_LIMIT,
    });
    expect(result.structuredContent.response_bytes).toBeGreaterThan(RESPONSE_LIMIT);
    expect(result.structuredContent).not.toHaveProperty('records');
    expect(result.structuredContent).not.toHaveProperty('display_records');
    expect(result.structuredContent).not.toHaveProperty('cursor');
    expect(metrics.result_bytes).toBeLessThanOrEqual(RESPONSE_LIMIT);
  });

  it.each([64, 12_000])(
    'bounds fetched and returned rows for %i-byte synthetic Notes fields',
    async (notesBytes) => {
      const synthetic = await createSyntheticSession({ notesBytes }, runtime);
      try {
        const { result, metrics } = await synthetic.call('bpm_get_records', {
          collection: 'Contact',
          select: 'Id,Name,Notes',
          auto_paginate: true,
          max_records: 1000,
          format: 'full',
        });
        expect(result.isError).toBeFalsy();
        expect(metrics.result_bytes).toBeLessThanOrEqual(RESPONSE_LIMIT);
        expect(metrics.returned_rows).toBeGreaterThan(0);
        expect(metrics.fetched_rows).toBeGreaterThanOrEqual(metrics.returned_rows);
        expect(metrics.fetched_rows).toBeLessThanOrEqual(1000);
        expect(metrics.data_request_count).toBeGreaterThanOrEqual(1);
      } finally {
        await synthetic.close();
      }
    }
  );

  it('rejects a single oversized field while preserving the raw 512KiB guard', async () => {
    for (const [notesBytes, expectedCode] of [
      [80 * 1024, 'response_too_large'],
      [600 * 1024, 'validation'],
    ] as const) {
      const large = await createSyntheticSession({ notesBytes }, runtime);
      try {
        const { result, metrics } = await large.call('bpm_get_records', {
          collection: 'Contact',
          top: 1,
          select: '*',
          format: 'full',
        });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({ success: false, code: expectedCode });
        expect(result.structuredContent).not.toHaveProperty('records');
        expect(result.structuredContent).not.toHaveProperty('cursor');
        expect(metrics.result_bytes).toBeLessThanOrEqual(RESPONSE_LIMIT);
      } finally {
        await large.close();
      }
    }
  });
});
