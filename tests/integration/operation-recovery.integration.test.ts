import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as z from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { initializeServices, type ServiceContainer } from '../../src/tools/init-tool.js';
import { createToolServer } from '../../src/server/tool-server.js';
import { instrumentTools, CHARACTER_LIMIT } from '../../src/server/instrumentation.js';
import { getOperation, listOperations } from '../../src/server/operation-journal.js';
import { runWithAuth } from '../../src/auth/request-context.js';
import { tenantStorageScope, userStorageScope } from '../../src/utils/tenant-scope.js';

const USER_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const USER_B = 'bbbbbbbb-0000-0000-0000-000000000002';
let root: string;
const connections: Array<{ client: Client; server: McpServer }> = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'bpm-operation-recovery-'));
  vi.stubEnv('BPMSOFT_METADATA_CACHE', 'off');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  for (const { client, server } of connections.splice(0)) {
    await client.close();
    await server.close();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

function services(tenant = 'east', timeout = 5000): ServiceContainer {
  const result = initializeServices(
    {
      bpmsoft_url: `https://${tenant}.example`,
      tenant_id: tenant,
      journal_root: join(root, 'operations'),
      odata_version: 4,
      platform: 'net8',
      page_size: 20,
      max_batch_size: 100,
      lookup_cache_ttl: 300,
      request_timeout: timeout,
      max_file_size: 1024 * 1024,
    },
    false
  );
  // Business metadata is a fixed fixture; auth, OData, HttpClient, journal and SDK remain real.
  vi.spyOn(result.metadataManager, 'resolveCollectionReference').mockResolvedValue({ name: 'Contact' });
  vi.spyOn(result.metadataManager, 'getEntityMetadata').mockResolvedValue({
    name: 'Contact',
    properties: [
      { name: 'Id', type: 'Edm.Guid' },
      { name: 'Name', type: 'Edm.String' },
    ],
    lookupFields: [],
    navigationProperties: [],
  } as never);
  vi.spyOn(result.lookupResolver, 'resolveDataLookups').mockImplementation(async (_collection, data) => ({
    data,
    notes: [],
  }));
  return result;
}

function auth(tenant = 'east', session = 'a-original') {
  return { tenantId: tenant, csrfToken: `csrf-${session}`, cookies: new Map([['.ASPXAUTH', session]]) };
}
function journalPath(container: ServiceContainer, id: string, user = USER_A) {
  return join(
    container.config.journal_root!,
    tenantStorageScope(container.config),
    userStorageScope(user),
    `${id}.json`
  );
}
async function connect(server: McpServer) {
  const client = new Client({ name: 'operation-recovery-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  connections.push({ client, server });
  await client.listTools();
  return client;
}
function id(result: CallToolResult) {
  expect(result._meta?.operation_id).toEqual(expect.any(String));
  return result._meta!.operation_id as string;
}

function backend(
  container: ServiceContainer,
  onWrite?: (body: Record<string, unknown>, options: RequestInit) => Promise<Response>
) {
  const records = new Map<string, Record<string, unknown>>();
  const writes: string[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, options: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith('/SelectQuery')) {
      const cookie = new Headers(options.headers).get('cookie') ?? '';
      return Response.json({ rows: [{ Id: cookie.includes('b-') ? USER_B : USER_A, Name: 'verified' }] });
    }
    if (options.method === 'POST') {
      const body = JSON.parse(options.body as string) as Record<string, unknown>;
      const page = await listOperations(container);
      const latest = await getOperation(
        container,
        page.operations.find((item) => item.status === 'outcome_unknown')!.operation_id
      );
      const durable = JSON.parse(await readFile(journalPath(container, latest.operation_id), 'utf8'));
      // Checkpoint must be on disk before a side effect is allowed to reach fetch.
      expect(durable.stages.at(-1)).toMatchObject({ status: 'started', method: 'POST', intent: { body } });
      writes.push(url);
      if (typeof body.Id === 'string') records.set(body.Id, body);
      return onWrite ? onWrite(body, options) : Response.json(body, { status: 201 });
    }
    const recordId = /\(([0-9a-f-]+)\)$/.exec(url)?.[1];
    const record = recordId && records.get(recordId);
    return record ? Response.json(record) : Response.json({ error: { message: 'missing' } }, { status: 404 });
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, writes };
}

describe('durable recovery through the production MCP factory and HttpClient', () => {
  it('checkpoints real dispatch, preserves the successful connector contract and recovers after session renewal', async () => {
    const container = services();
    const upstream = backend(container);
    const client = await connect(createToolServer(container));
    const result = (await runWithAuth(auth(), () =>
      client.callTool({
        name: 'bpm_create_record',
        arguments: { collection: 'Contact', data: { Name: 'Alice' } },
      })
    )) as CallToolResult;
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      collection: 'Contact',
      created: true,
      record: { Name: 'Alice', Id: expect.any(String) },
    });
    const operationId = id(result);
    expect(upstream.writes).toHaveLength(1);
    expect(await runWithAuth(auth(), () => getOperation(container, operationId))).toMatchObject({
      status: 'completed',
      stages: [{ status: 'completed', http_status: 201 }],
    });

    const restarted = services();
    const recovery = await connect(createToolServer(restarted));
    const recovered = (await runWithAuth(auth('east', 'a-renewed'), () =>
      recovery.callTool({
        name: 'bpm_get_operation',
        arguments: { operation_id: operationId, include_receipt: true },
      })
    )) as CallToolResult;
    expect(recovered.structuredContent).toMatchObject({
      operation: { operation_id: operationId, status: 'completed', safe_to_retry: false },
    });
    const lostId = (await runWithAuth(auth('east', 'a-renewed'), () =>
      recovery.callTool({ name: 'bpm_get_operation', arguments: {} })
    )) as CallToolResult;
    expect(lostId.structuredContent?.operations).toEqual([
      expect.objectContaining({ operation_id: operationId }),
    ]);
    const otherUser = (await runWithAuth(auth('east', 'b-other'), () =>
      recovery.callTool({ name: 'bpm_get_operation', arguments: { operation_id: operationId } })
    )) as CallToolResult;
    expect(otherUser.isError).toBe(true);
    expect(otherUser.structuredContent).toMatchObject({ error: 'Операция не найдена.' });
    const foreign = await connect(createToolServer(services('west')));
    const otherTenant = (await runWithAuth(auth('west', 'a-renewed'), () =>
      foreign.callTool({ name: 'bpm_get_operation', arguments: { operation_id: operationId } })
    )) as CallToolResult;
    expect(otherTenant.isError).toBe(true);
    expect(upstream.writes).toHaveLength(1);
  });

  it('retains an uncertain dispatched mutation even when reconciliation finds the created record', async () => {
    const container = services('east', 100);
    const upstream = backend(
      container,
      async (_body, options) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = options.signal!;
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        })
    );
    const client = await connect(createToolServer(container));
    const result = (await runWithAuth(auth(), () =>
      client.callTool({
        name: 'bpm_create_record',
        arguments: { collection: 'Contact', data: { Name: 'Possibly created' } },
      })
    )) as CallToolResult;
    expect(result.structuredContent).toMatchObject({ created: null, record: { Name: 'Possibly created' } });
    const stored = await runWithAuth(auth(), () => getOperation(container, id(result)));
    expect(stored).toMatchObject({
      status: 'outcome_unknown',
      requires_state_verification: true,
      safe_to_retry: false,
      stages: [{ status: 'outcome_unknown' }],
    });
    expect(upstream.writes).toHaveLength(1);
  });

  it('leaves an uncertain durable stage and stops the next dispatch if its receipt cannot be saved', async () => {
    const container = services();
    const upstream = backend(container, async () =>
      Response.json({ details: 'x'.repeat(2 * 1024 * 1024) }, { status: 201 })
    );
    const server = instrumentTools(new McpServer({ name: 'receipt-failure', version: '1' }), container);
    server.registerTool('write_twice', { annotations: { readOnlyHint: false } }, async () => {
      const request = () =>
        container.httpClient.request({
          method: 'POST',
          url: 'https://east.example/odata/Contact',
          body: { Name: 'one' },
        });
      await request();
      await request();
      return { content: [{ type: 'text', text: 'complete' }] };
    });
    const client = await connect(server);
    const result = (await runWithAuth(auth(), () =>
      client.callTool({ name: 'write_twice' })
    )) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: 'outcome_unknown', safe_to_retry: false });
    expect(result._meta).toMatchObject({
      operation_status: 'outcome_unknown',
      journal_receipt_persisted: false,
    });
    expect(upstream.writes).toHaveLength(1);
    const stored = await runWithAuth(auth(), () => getOperation(container, id(result)));
    expect(stored).toMatchObject({ status: 'outcome_unknown', stages: [{ status: 'started' }] });
  });

  it('returns the recovery ID for a malformed successful output and keeps it visible when text is clipped', async () => {
    const container = services();
    backend(container);
    const server = instrumentTools(new McpServer({ name: 'output-recovery', version: '1' }), container);
    for (const malformed of [true, false]) {
      server.registerTool(
        `write_${malformed}`,
        { annotations: { readOnlyHint: false }, outputSchema: { value: z.string() } },
        async () => {
          await container.httpClient.request({
            method: 'POST',
            url: 'https://east.example/odata/Contact',
            body: { Name: 'persisted' },
          });
          return {
            content: [{ type: 'text', text: 'x'.repeat(CHARACTER_LIMIT + 1000) }],
            structuredContent: { value: malformed ? 42 : 'okay' },
          };
        }
      );
    }
    const client = await connect(server);
    const malformed = (await runWithAuth(auth(), () =>
      client.callTool({ name: 'write_true' })
    )) as CallToolResult;
    expect(malformed.isError).toBe(true);
    const failed = await runWithAuth(auth(), () => getOperation(container, id(malformed)));
    expect(failed).toMatchObject({
      status: 'failed',
      requires_state_verification: true,
      stages: [{ status: 'completed' }],
    });
    const clipped = (await runWithAuth(auth(), () =>
      client.callTool({ name: 'write_false' })
    )) as CallToolResult;
    expect(clipped.isError).toBeFalsy();
    expect(clipped.content.some((part) => part.type === 'text' && part.text.includes(id(clipped)))).toBe(
      true
    );
    expect(clipped.structuredContent).toEqual({ value: 'okay' });
  });
});
