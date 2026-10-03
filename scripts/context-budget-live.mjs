import { createInterface } from 'node:readline';
import { writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createToolServer } from '../build/server/tool-server.js';
import { initializeServices } from '../build/tools/init-tool.js';
import { buildConfig } from '../build/config.js';
import { productionProvenance } from './lib/context-budget-provenance.mjs';

// One JSON line on stdin: credentials remain in memory and never enter the report.
// Only the authentication POST and the hard-coded observational tools below run.
process.env.BPMSOFT_DEBUG = '';
const input = createInterface({ input: process.stdin, terminal: false });
console.log(JSON.stringify({ ready: true }));
const { value: line } = await input[Symbol.asyncIterator]().next();
input.close();
const credentials = JSON.parse(line);
const config = buildConfig(credentials.url, credentials.username, credentials.password, {
  platform: 'net8',
  odata_version: 4,
});
config.page_size = 200;
const services = initializeServices(config, true);
delete credentials.username;
delete credentials.password;
const client = new Client({ name: 'context-budget-live', version: '1.0.0' });
const server = createToolServer(services);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
let envelopeBytes;
const send = serverTransport.send.bind(serverTransport);
serverTransport.send = async (message, ...args) => {
  if (message.result?.content) envelopeBytes = Buffer.byteLength(JSON.stringify(message));
  return send(message, ...args);
};
const measurements = [];
let selectedId;

async function measure(label, name, args) {
  const started = performance.now();
  envelopeBytes = undefined;
  const result = await client.callTool({ name, arguments: args });
  const data = result.structuredContent ?? {};
  const text = result.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
  const metric = {
    scenario: label,
    tool: name,
    result_bytes: Buffer.byteLength(JSON.stringify(result)),
    jsonrpc_bytes: envelopeBytes,
    text_characters: text.length,
    text_bytes: Buffer.byteLength(text),
    structured_bytes: Buffer.byteLength(JSON.stringify(data)),
    is_error: result.isError === true,
    code: data.code,
    returned_count: Array.isArray(data.records) ? data.records.length : undefined,
    count: data.count,
    scanned_count: data.scanned_count,
    total_count: data.total_count,
    complete: data.complete,
    has_more: data.has_more,
    response_bytes: data.response_bytes,
    response_limit_bytes: data.response_limit_bytes,
    elapsed_ms: Math.round(performance.now() - started),
  };
  measurements.push(metric);
  console.log(JSON.stringify(metric));
  if (!selectedId && Array.isArray(data.records)) selectedId = data.records[0]?.Id;
  return { metric, data };
}

try {
  await services.authManager.login();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  await client.listTools();
  const candidates = credentials.collection
    ? [credentials.collection]
    : [
        'Contact',
        'Activity',
        'Account',
        'SysProcessLog',
        'SysProcessElementLog',
        'SysSchema',
        'SysAdminUnit',
      ];
  let collection;
  let population = -1;
  for (const candidate of candidates) {
    const { metric, data } = await measure(`count:${candidate}`, 'bpm_count_records', {
      collection: candidate,
    });
    if (!metric.is_error && data.count > population) {
      collection = candidate;
      population = data.count;
    }
  }
  if (!collection) throw new Error('No readable candidate collection');
  selectedId = undefined;
  await measure('broad_default', 'bpm_get_records', { collection, count: true, resolve_references: false });
  await measure('broad_auto_compact', 'bpm_get_records', {
    collection,
    count: true,
    auto_paginate: true,
    max_records: 1000,
    resolve_references: false,
  });
  await measure('broad_auto_full', 'bpm_get_records', {
    collection,
    select: '*',
    count: true,
    auto_paginate: true,
    max_records: 1000,
    format: 'full',
    resolve_references: false,
  });
  if (selectedId) {
    await measure('selective_id', 'bpm_search_records', {
      collection,
      criteria: [{ field: 'Id', op: 'eq', value: selectedId }],
      select: 'Id',
      count: true,
      resolve_references: false,
    });
  }
  await measure('aggregate_default', 'bpm_aggregate_records', { collection });
  const report = {
    schema_version: 1,
    mode: 'live-read-only',
    measured_at: new Date().toISOString(),
    origin: new URL(config.bpmsoft_url).origin,
    collection,
    actual_population: population,
    model_invoked: false,
    record_payloads_saved: false,
    ...(await productionProvenance()),
    measurements,
  };
  const outputIndex = process.argv.indexOf('--output');
  if (outputIndex !== -1) {
    const path = process.argv[outputIndex + 1];
    if (!path) throw new Error('Missing --output path');
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify({ complete: true, collection, actual_population: population }));
} finally {
  await client.close();
  await server.close();
  config.password = undefined;
  config.username = undefined;
}
