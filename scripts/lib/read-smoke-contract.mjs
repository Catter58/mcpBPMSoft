import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';

export const SAFE_TOOL_NAMES = [
  'bpm_whoami',
  'bpm_get_collections',
  'bpm_get_schema',
  'bpm_get_records',
  'bpm_count_records',
  'bpm_aggregate_records',
];

function buildPreflightCalls(collection, fixtures) {
  const fixtureFilter = fixtures.map(({ id }) => `Id eq ${id}`).join(' or ');
  const criterion = { field: 'Id', op: 'eq', value: fixtures[0].id };
  const summaryCursorFirstPage = {
    name: 'bpm_get_records',
    args: {
      collection,
      filter: fixtureFilter,
      select: 'Id,Name',
      top: 1,
      count: true,
      resolve_references: false,
      format: 'summary',
    },
  };

  const preflightCalls = [
    { name: 'bpm_whoami', args: { timezone: 'Europe/Moscow' } },
    { name: 'bpm_get_collections', args: { pattern: collection, limit: 100 } },
    { name: 'bpm_get_schema', args: { collection } },
    {
      name: 'bpm_get_records',
      args: {
        collection,
        filter: fixtureFilter,
        select: 'Id,Name',
        top: 1,
        count: true,
        resolve_references: false,
      },
    },
    { name: 'bpm_get_records', args: { cursor: 'preflight-cursor' } },
    {
      name: 'bpm_get_records',
      args: {
        collection,
        filter: fixtureFilter,
        select: 'Id,Name',
        auto_paginate: true,
        max_records: fixtures.length,
        count: true,
        resolve_references: false,
      },
    },
    { name: 'bpm_count_records', args: { collection, criteria: [criterion] } },
    {
      name: 'bpm_aggregate_records',
      args: { collection, criteria: [criterion], max_records: fixtures.length },
    },
    {
      name: 'bpm_get_records',
      args: {
        collection,
        filter: fixtureFilter,
        select: 'Id,Name',
        auto_paginate: true,
        max_records: fixtures.length,
        count: true,
        resolve_references: false,
        format: 'summary',
      },
    },
    summaryCursorFirstPage,
  ];
  return { preflightCalls, summaryCursorFirstPage };
}

/** Verify SDK-published read-only contracts before credentials or live network are used. */
export function prepareToolContracts(tools, { collection, fixtures }) {
  if (!collection || !Array.isArray(fixtures) || fixtures.length < 1)
    throw new Error('A collection and expected fixtures are required');

  const { preflightCalls, summaryCursorFirstPage } = buildPreflightCalls(collection, fixtures);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const validatorProvider = new AjvJsonSchemaValidator();
  const validators = new Map();

  for (const name of SAFE_TOOL_NAMES) {
    const tool = byName.get(name);
    if (!tool) throw new Error(`Required read-only tool is unavailable: ${name}`);
    if (tool.annotations?.readOnlyHint !== true) throw new Error(`Tool is not marked read-only: ${name}`);
    if (!tool.inputSchema || typeof tool.inputSchema !== 'object')
      throw new Error(`Tool has no published input schema: ${name}`);
    try {
      validators.set(name, validatorProvider.getValidator(tool.inputSchema));
    } catch {
      throw new Error(`Tool input schema cannot be validated: ${name}`);
    }
  }

  const contracts = {
    validate(name, args) {
      const validator = validators.get(name);
      if (!validator) throw new Error(`Tool is outside the read-only allowlist: ${name}`);
      const result = validator(args);
      if (!result.valid) throw new Error(`Arguments do not match the published schema for ${name}`);
      return args;
    },
  };

  for (const call of preflightCalls) contracts.validate(call.name, call.args);
  return { ...contracts, preflightCalls, summaryCursorFirstPage };
}

export function requireSuccessfulResult(result, toolName) {
  if (!result || result.isError === true || !result.structuredContent)
    throw new Error(`Read-only tool call failed: ${toolName}`);
  return result.structuredContent;
}

export function assertRecords(records, expected) {
  if (!Array.isArray(records)) throw new Error('Records were not returned as a list');
  const actual = records.map(({ Id, Name }) => ({ id: Id, name: Name }));
  const wanted = expected.map(({ id, name }) => ({ id, name }));
  const sortById = (left, right) => left.id.localeCompare(right.id);
  if (JSON.stringify(actual.toSorted(sortById)) !== JSON.stringify(wanted.toSorted(sortById)))
    throw new Error('Record IDs or names did not match the expected fixtures');
  return actual;
}

export function assertFirstPage(data, expectedRecord, totalCount) {
  const records = assertRecords(data.records, [expectedRecord]);
  if (data.count !== 1 || data.total_count !== totalCount || data.has_more !== true || !data.cursor)
    throw new Error('First page did not return the expected continuation');
  return { record: records[0], cursor: data.cursor };
}

export function assertFinalPage(data, expectedRecord) {
  const records = assertRecords(data.records, [expectedRecord]);
  if (data.count !== 1 || data.has_more !== false || data.cursor !== undefined)
    throw new Error('Final page did not complete the result set');
  return records[0];
}

export function assertCompleteAggregate(data, expectedCount = 1) {
  if (
    data.complete !== true ||
    data.scanned_count !== expectedCount ||
    data.has_more !== false ||
    data.groups?.length !== 1 ||
    data.groups[0]?.count !== expectedCount
  )
    throw new Error('Aggregate was incomplete or returned an unexpected count');
}
