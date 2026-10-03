import { performance } from 'node:perf_hooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

export const COLLECTION_SIZE = 100_000;
export const TARGET_NAME = 'Искомая запись 100000';
export const BACKEND_PAGE_SIZE = 200;

const fields = ['Id', 'Name', 'Email', 'Amount', 'Category', 'Notes'];
const metadata = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices><Schema Namespace="Synthetic" xmlns="http://docs.oasis-open.org/odata/ns/edm">
    <EntityType Name="Contact"><Key><PropertyRef Name="Id"/></Key>
      <Property Name="Id" Type="Edm.Guid" Nullable="false"/>
      <Property Name="Name" Type="Edm.String"/>
      <Property Name="Email" Type="Edm.String"/>
      <Property Name="Amount" Type="Edm.Decimal"/>
      <Property Name="Category" Type="Edm.String"/>
      <Property Name="Notes" Type="Edm.String"/>
    </EntityType>
    <EntityContainer Name="Default"><EntitySet Name="Contact" EntityType="Synthetic.Contact"/></EntityContainer>
  </Schema></edmx:DataServices>
</edmx:Edmx>`;

export function recordId(index) {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function multilingualText(bytes) {
  const phrase = 'Пример 日本語 café 🙂 English. ';
  let text = phrase.repeat(Math.ceil(bytes / Buffer.byteLength(phrase)));
  while (Buffer.byteLength(text) > bytes) text = [...text].slice(0, -1).join('');
  return text + 'x'.repeat(bytes - Buffer.byteLength(text));
}

function makeRow(index, total, notes) {
  return {
    Id: recordId(index),
    Name: index === total ? TARGET_NAME : `Контакт ${String(index).padStart(6, '0')}`,
    Email: `contact${index}@example.invalid`,
    Amount: `${index}.25`,
    Category: index <= 200 ? 'Narrow' : `Group ${index % 10}`,
    Notes: notes,
  };
}

/** Deliberately bounded OData syntax for this experiment; unsupported filters fail loudly. */
function compilePredicate(filter) {
  if (!filter) return () => true;
  const expression = filter
    .trim()
    .replace(/^\((.*)\)$/s, '$1')
    .trim();
  const match =
    /^(Id|Name|Email|Amount|Category|Notes)\s+(eq|ne|gt|ge|lt|le)\s+(?:'((?:[^']|'')*)'|([^\s]+))$/.exec(
      expression
    );
  if (!match) throw new Error(`Synthetic fixture does not support filter: ${filter}`);
  const [, field, operator, quoted, bare] = match;
  const expected = quoted === undefined ? bare : quoted.replaceAll("''", "'");
  return (row) => {
    const actual = field === 'Amount' ? Number(row[field]) : row[field];
    const target = field === 'Amount' ? Number(expected) : expected;
    switch (operator) {
      case 'eq':
        return actual === target;
      case 'ne':
        return actual !== target;
      case 'gt':
        return actual > target;
      case 'ge':
        return actual >= target;
      case 'lt':
        return actual < target;
      case 'le':
        return actual <= target;
      default:
        throw new Error(`Unsupported operator: ${operator}`);
    }
  };
}

export class SyntheticOData {
  constructor({ totalRows = COLLECTION_SIZE, notesBytes = 2048, pageSize = BACKEND_PAGE_SIZE } = {}) {
    this.totalRows = totalRows;
    this.notes = multilingualText(notesBytes);
    this.pageSize = pageSize;
    this.reset();
  }

  reset() {
    this.metrics = {
      data_request_count: 0,
      count_request_count: 0,
      metadata_request_count: 0,
      fetched_rows: 0,
    };
  }

  async request(options) {
    const url = new URL(options.url);
    let data;
    if (options.method !== 'GET') throw new Error('The experiment permits read requests only');
    if (url.pathname === '/odata/$metadata') {
      this.metrics.metadata_request_count++;
      data = metadata;
    } else if (['/odata/SysSchema', '/odata/VwSysEntitySchemaColumn'].includes(url.pathname)) {
      this.metrics.metadata_request_count++;
      data = { value: [] };
    } else if (['/odata/Contact', '/odata/Contact/$count'].includes(url.pathname)) {
      const predicate = compilePredicate(url.searchParams.get('$filter'));
      const matching = [];
      for (let index = 1; index <= this.totalRows; index++) {
        const row = makeRow(index, this.totalRows, this.notes);
        if (predicate(row)) matching.push(index);
      }
      if (url.pathname.endsWith('/$count')) {
        this.metrics.count_request_count++;
        data = String(matching.length);
      } else {
        this.metrics.data_request_count++;
        const order = url.searchParams.get('$orderby');
        if (order && order !== 'Id asc' && order !== 'Id desc') throw new Error(`Unsupported sort: ${order}`);
        if (order === 'Id desc') matching.reverse();
        const skip = Number(url.searchParams.get('$skip') ?? 0);
        const requested = Number(url.searchParams.get('$top') ?? this.pageSize);
        const selected = url.searchParams.get('$select')?.split(',') ?? fields;
        if (selected.some((field) => !fields.includes(field))) throw new Error('Unknown selected field');
        const accepted = matching.slice(skip, skip + Math.min(requested, this.pageSize));
        const value = accepted.map((index) => {
          const row = makeRow(index, this.totalRows, this.notes);
          return Object.fromEntries(selected.map((field) => [field, row[field]]));
        });
        this.metrics.fetched_rows += value.length;
        data = { value };
        if (url.searchParams.get('$count') === 'true') data['@odata.count'] = matching.length;
        if (skip + value.length < matching.length && value.length < requested) {
          const next = new URL(url);
          next.searchParams.set('$skip', String(skip + value.length));
          next.searchParams.set('$top', String(requested - value.length));
          data['@odata.nextLink'] = next.href;
        }
      }
    } else throw new Error(`Unexpected synthetic HTTP request: ${options.method} ${url.pathname}`);
    return { status: 200, statusText: 'OK', headers: {}, data, ok: true };
  }
}

async function defaultRuntime() {
  const [{ initializeServices }, { createToolServer }, { runWithAuth }] = await Promise.all([
    import('../../build/tools/init-tool.js'),
    import('../../build/server/tool-server.js'),
    import('../../build/auth/request-context.js'),
  ]);
  return { initializeServices, createToolServer, runWithAuth };
}

/** Uses production services and MCP validation; only HTTP request(opts) is substituted. */
export async function createSyntheticSession(options = {}, runtime) {
  const implementation = runtime ?? (await defaultRuntime());
  const backend = new SyntheticOData(options);
  const services = implementation.initializeServices(
    {
      bpmsoft_url: 'https://context-budget.invalid',
      odata_version: 4,
      platform: 'net8',
      page_size: BACKEND_PAGE_SIZE,
      max_batch_size: 100,
      lookup_cache_ttl: 300,
      request_timeout: 30000,
      max_file_size: 10485760,
    },
    false
  );
  services.httpClient.request = backend.request.bind(backend);
  const server = implementation.createToolServer(services);
  const client = new Client({ name: 'numeric-context-budget', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let wireBytes = 0;
  const originalSend = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (message, extra) => {
    if (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))
      wireBytes = Buffer.byteLength(JSON.stringify(message));
    return originalSend(message, extra);
  };
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  // This registers the published output schemas in the SDK Client validator.
  const { tools } = await client.listTools();
  const auth = { csrfToken: 'synthetic-csrf', cookies: new Map([['.ASPXAUTH', 'synthetic-session']]) };
  return {
    tools,
    services,
    backend,
    async call(name, args) {
      backend.reset();
      wireBytes = 0;
      const started = performance.now();
      const result = await implementation.runWithAuth(auth, () => client.callTool({ name, arguments: args }));
      const elapsed = performance.now() - started;
      const structured = result.structuredContent ?? {};
      const texts = (result.content ?? []).filter((part) => part.type === 'text').map((part) => part.text);
      const records = structured.records;
      return {
        result,
        metrics: {
          tool: name,
          result_bytes: Buffer.byteLength(JSON.stringify(result)),
          text_characters: texts.reduce((sum, value) => sum + value.length, 0),
          text_bytes: texts.reduce((sum, value) => sum + Buffer.byteLength(value), 0),
          structured_bytes: Buffer.byteLength(JSON.stringify(structured)),
          jsonrpc_bytes: wireBytes,
          returned_rows: Array.isArray(records) ? records.length : 0,
          scanned_count: structured.scanned_count ?? null,
          total_count: structured.total_count ?? (name === 'bpm_count_records' ? structured.count : null),
          complete: structured.complete ?? null,
          has_more: structured.has_more ?? null,
          is_error: !!result.isError,
          error_code: structured.code ?? null,
          ...backend.metrics,
          synthetic_elapsed_ms: Number(elapsed.toFixed(3)),
        },
      };
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

export const scenarios = [
  { name: 'broad_default', tool: 'bpm_get_records', args: { collection: 'Contact', count: true } },
  {
    name: 'top_1000_compact',
    tool: 'bpm_get_records',
    args: { collection: 'Contact', top: 1000, format: 'compact', count: true },
  },
  {
    name: 'wide_20_full_unicode',
    tool: 'bpm_get_records',
    args: { collection: 'Contact', top: 20, select: '*', format: 'full', count: true },
  },
  {
    name: 'auto_1000_full_selected',
    tool: 'bpm_get_records',
    args: {
      collection: 'Contact',
      select: 'Id,Name,Email,Amount,Category',
      auto_paginate: true,
      max_records: 1000,
      format: 'full',
      count: true,
    },
  },
  {
    name: 'auto_1000_full_wide',
    tool: 'bpm_get_records',
    args: {
      collection: 'Contact',
      select: '*',
      auto_paginate: true,
      max_records: 1000,
      format: 'full',
      count: true,
    },
  },
  {
    name: 'selective_search_far_end',
    tool: 'bpm_search_records',
    args: {
      collection: 'Contact',
      criteria: [{ field: 'Name', op: 'eq', value: TARGET_NAME }],
      select: 'Id,Name,Email',
      count: true,
    },
  },
  {
    name: 'aggregate_default_5000',
    tool: 'bpm_aggregate_records',
    args: {
      collection: 'Contact',
      group_by: ['Category'],
      metrics: [{ field: 'Amount', op: 'sum', alias: 'total_amount' }],
    },
  },
  {
    name: 'aggregate_max_20000',
    tool: 'bpm_aggregate_records',
    args: {
      collection: 'Contact',
      group_by: ['Category'],
      metrics: [{ field: 'Amount', op: 'sum', alias: 'total_amount' }],
      max_records: 20000,
    },
  },
  {
    name: 'aggregate_narrowed_complete',
    tool: 'bpm_aggregate_records',
    args: {
      collection: 'Contact',
      group_by: ['Category'],
      metrics: [{ field: 'Amount', op: 'sum', alias: 'total_amount' }],
      criteria: [{ field: 'Category', op: 'eq', value: 'Narrow' }],
    },
  },
  { name: 'count_only', tool: 'bpm_count_records', args: { collection: 'Contact' } },
];

export async function runContextBudget(runtime) {
  const session = await createSyntheticSession({}, runtime);
  const observations = [];
  try {
    for (const scenario of scenarios) {
      const { metrics } = await session.call(scenario.tool, scenario.args);
      observations.push({ scenario: scenario.name, ...metrics });
    }
  } finally {
    await session.close();
  }
  for (const [name, notesBytes] of [
    ['oversized_single_row', 80 * 1024],
    ['raw_512k_guard', 600 * 1024],
  ]) {
    const oversized = await createSyntheticSession({ notesBytes }, runtime);
    try {
      const { metrics } = await oversized.call('bpm_get_records', {
        collection: 'Contact',
        top: 1,
        select: '*',
        format: 'full',
        count: true,
      });
      observations.push({ scenario: name, ...metrics });
    } finally {
      await oversized.close();
    }
  }
  return {
    experiment: 'synthetic-odata-context-budget',
    collection_rows: COLLECTION_SIZE,
    backend_page_size: BACKEND_PAGE_SIZE,
    notes_utf8_bytes: 2048,
    model_calls: 0,
    real_network_requests: 0,
    measurement:
      'UTF-8 JSON bytes; text_characters uses JavaScript UTF-16 length; elapsed measures this synthetic local workload only.',
    observations,
  };
}
