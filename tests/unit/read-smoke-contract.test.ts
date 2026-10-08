import { describe, expect, it } from 'vitest';
import {
  assertCompleteAggregate,
  assertFinalPage,
  assertFirstPage,
  assertRecords,
  prepareToolContracts,
} from '../../scripts/lib/read-smoke-contract.mjs';

const fixtures = [
  { id: '11111111-2222-4333-8444-555555555555', name: 'Northwind Orchard' },
  { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Contoso Atelier' },
];
const string = { type: 'string' };
const integer = { type: 'integer' };
const boolean = { type: 'boolean' };
const criterion = {
  type: 'object',
  properties: { field: string, op: string, value: {} },
  required: ['op'],
};

function publishedTools() {
  const schemas = {
    bpm_whoami: { timezone: string },
    bpm_get_collections: { pattern: string, limit: integer },
    bpm_get_schema: { collection: string },
    bpm_get_records: {
      collection: string,
      filter: string,
      select: string,
      top: integer,
      count: boolean,
      format: { type: 'string', enum: ['compact', 'full', 'markdown', 'summary'] },
      resolve_references: boolean,
      cursor: string,
      auto_paginate: boolean,
      max_records: integer,
    },
    bpm_count_records: { collection: string, criteria: { type: 'array', items: criterion } },
    bpm_aggregate_records: {
      collection: string,
      criteria: { type: 'array', items: criterion },
      max_records: integer,
    },
  };
  return Object.entries(schemas).map(([name, properties]) => ({
    name,
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties,
      ...(name === 'bpm_get_schema' || name === 'bpm_count_records' || name === 'bpm_aggregate_records'
        ? { required: ['collection'] }
        : {}),
      additionalProperties: false,
    },
  }));
}

function prepare() {
  return prepareToolContracts(publishedTools(), { collection: 'Orchard', fixtures });
}

describe('read-only smoke contract', () => {
  it('validates each preflight call against the published input schemas', () => {
    const contract = prepare();
    for (const call of contract.preflightCalls)
      expect(contract.validate(call.name, call.args)).toEqual(call.args);
    expect(() => contract.validate('bpm_delete_record', {})).toThrow(/allowlist/);
  });

  it('stops preflight when a required tool is missing or no longer read-only', () => {
    const missing = publishedTools().filter((tool) => tool.name !== 'bpm_whoami');
    expect(() => prepareToolContracts(missing, { collection: 'Orchard', fixtures })).toThrow(/unavailable/);

    const changed = publishedTools().map((tool) =>
      tool.name === 'bpm_get_records' ? { ...tool, annotations: { readOnlyHint: false } } : tool
    );
    expect(() => prepareToolContracts(changed, { collection: 'Orchard', fixtures })).toThrow(
      /not marked read-only/
    );
  });

  it('detects input schema drift before any preflight call can run', () => {
    const changed = publishedTools().map((tool) => {
      if (tool.name !== 'bpm_get_records') return tool;
      const { filter: _filter, ...properties } = tool.inputSchema.properties;
      return { ...tool, inputSchema: { ...tool.inputSchema, properties } };
    });
    expect(() => prepareToolContracts(changed, { collection: 'Orchard', fixtures })).toThrow(
      /published schema/
    );

    const noSummary = publishedTools().map((tool) =>
      tool.name === 'bpm_get_records'
        ? {
            ...tool,
            inputSchema: {
              ...tool.inputSchema,
              properties: {
                ...tool.inputSchema.properties,
                format: { type: 'string', enum: ['compact', 'full', 'markdown'] },
              },
            },
          }
        : tool
    );
    expect(() => prepareToolContracts(noSummary, { collection: 'Orchard', fixtures })).toThrow(
      /published schema/
    );
  });

  it('requires exact expected record IDs and names in returned pages', () => {
    expect(
      assertRecords(
        fixtures.map(({ id, name }) => ({ Id: id, Name: name })),
        fixtures
      )
    ).toEqual(fixtures);
    expect(() => assertRecords([{ Id: fixtures[0].id, Name: 'A different orchard' }], [fixtures[0]])).toThrow(
      /did not match/
    );
    const duplicate = { Id: fixtures[0].id, Name: fixtures[0].name };
    expect(() => assertRecords([duplicate, duplicate], [fixtures[0]])).toThrow(/did not match/);
  });

  it('checks cursor completion and aggregate count invariants', () => {
    expect(
      assertFirstPage(
        {
          records: [{ Id: fixtures[0].id, Name: fixtures[0].name }],
          count: 1,
          total_count: 2,
          has_more: true,
          cursor: 'opaque-next-page',
        },
        fixtures[0],
        fixtures.length
      ).cursor
    ).toBe('opaque-next-page');
    expect(
      assertFinalPage(
        { records: [{ Id: fixtures[1].id, Name: fixtures[1].name }], count: 1, has_more: false },
        fixtures[1]
      ).id
    ).toBe(fixtures[1].id);
    expect(() =>
      assertCompleteAggregate({
        complete: false,
        scanned_count: 1,
        has_more: true,
        groups: [{ count: 1 }],
      })
    ).toThrow(/incomplete/);
    expect(
      assertCompleteAggregate({ complete: true, scanned_count: 1, has_more: false, groups: [{ count: 1 }] })
    ).toBeUndefined();
  });
});
