/**
 * Unit tests for the two-step delete confirmation flow (confirm=true param)
 * across bpm_delete_record, bpm_delete_by_filter, bpm_batch_delete, bpm_field_delete.
 */

import { describe, it, expect, vi } from 'vitest';
import { registerWriteTools } from '../../src/tools/write-tools.js';
import { registerBatchTools } from '../../src/tools/batch-tools.js';
import type { ServiceContainer } from '../../src/tools/init-tool.js';

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface RegisteredTool {
  name: string;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

interface FakeServer {
  registered: RegisteredTool[];
  registerTool: (name: string, _meta: unknown, handler: RegisteredTool['handler']) => void;
}

function buildFakeServer(): FakeServer {
  const registered: RegisteredTool[] = [];
  return {
    registered,
    registerTool(name, _meta, handler) {
      registered.push({ name, handler });
    },
  };
}

interface StubState {
  deleteRecordCalls: Array<{ collection: string; id: string }>;
  executeBatchCalls: Array<Array<{ method: string; url: string }>>;
}

function buildStubServices(state: StubState): ServiceContainer {
  const odataClient = {
    async getRecord(collection: string, id: string) {
      return { Id: id, Name: `Test ${collection} ${id}` };
    },
    async getRecords(_collection: string, _query?: { $filter?: string; $select?: string; $top?: number }) {
      return {
        value: [
          { Id: 'aaaaaaaa-0000-0000-0000-000000000001' },
          { Id: 'aaaaaaaa-0000-0000-0000-000000000002' },
        ],
      };
    },
    async deleteRecord(collection: string, id: string) {
      state.deleteRecordCalls.push({ collection, id });
    },
    buildRecordPath(collection: string, id: string) {
      return `/${collection}(${id})`;
    },
    async executeBatch(requests: Array<{ method: string; url: string }>, _continueOnError: boolean) {
      state.executeBatchCalls.push(requests);
      return { responses: requests.map((_, i) => ({ id: String(i + 1), status: 204, body: null })) };
    },
  };

  const authManager = { ensureAuthenticated: vi.fn(async () => undefined) };

  return {
    config: null!,
    httpClient: null!,
    authManager: authManager as unknown as ServiceContainer['authManager'],
    odataClient: odataClient as unknown as ServiceContainer['odataClient'],
    metadataManager: null! as ServiceContainer['metadataManager'],
    lookupResolver: null! as ServiceContainer['lookupResolver'],
    processEngine: null! as ServiceContainer['processEngine'],
    initialized: true,
  };
}

function getHandler(server: FakeServer, name: string): RegisteredTool['handler'] {
  const tool = server.registered.find((r) => r.name === name);
  if (!tool) throw new Error(`${name} not registered`);
  return tool.handler;
}

describe('bpm_delete_record confirmation', () => {
  it('without confirm returns a preview and does not delete', async () => {
    const state: StubState = { deleteRecordCalls: [], executeBatchCalls: [] };
    const services = buildStubServices(state);
    const server = buildFakeServer();
    registerWriteTools(server as never, services);

    const handler = getHandler(server, 'bpm_delete_record');
    const result = await handler({ collection: 'Contact', id: '11111111-2222-3333-4444-555555555555' });

    expect(state.deleteRecordCalls).toHaveLength(0);
    expect(result.structuredContent?.requires_confirmation).toBe(true);
    expect(result.content[0].text).toContain('confirm=true');
  });

  it('with confirm=true deletes the record', async () => {
    const state: StubState = { deleteRecordCalls: [], executeBatchCalls: [] };
    const services = buildStubServices(state);
    const server = buildFakeServer();
    registerWriteTools(server as never, services);

    const handler = getHandler(server, 'bpm_delete_record');
    const result = await handler({
      collection: 'Contact',
      id: '11111111-2222-3333-4444-555555555555',
      confirm: true,
    });

    expect(state.deleteRecordCalls).toEqual([
      { collection: 'Contact', id: '11111111-2222-3333-4444-555555555555' },
    ]);
    expect(result.structuredContent?.requires_confirmation).toBeUndefined();
    expect(result.structuredContent?.deleted).toBe(true);
  });
});

describe('bpm_delete_by_filter confirmation', () => {
  it('without confirm returns a preview with the id list and does not delete', async () => {
    const state: StubState = { deleteRecordCalls: [], executeBatchCalls: [] };
    const services = buildStubServices(state);
    const server = buildFakeServer();
    registerWriteTools(server as never, services);

    const handler = getHandler(server, 'bpm_delete_by_filter');
    const result = await handler({ collection: 'Contact', filter: "Name eq 'X'", expected_count: 2 });

    expect(state.deleteRecordCalls).toHaveLength(0);
    expect(result.structuredContent?.requires_confirmation).toBe(true);
    expect(result.structuredContent?.count).toBe(2);
    expect(result.structuredContent?.ids).toEqual([
      'aaaaaaaa-0000-0000-0000-000000000001',
      'aaaaaaaa-0000-0000-0000-000000000002',
    ]);
  });

  it('with confirm=true deletes the matched records', async () => {
    const state: StubState = { deleteRecordCalls: [], executeBatchCalls: [] };
    const services = buildStubServices(state);
    const server = buildFakeServer();
    registerWriteTools(server as never, services);

    const handler = getHandler(server, 'bpm_delete_by_filter');
    const result = await handler({
      collection: 'Contact',
      filter: "Name eq 'X'",
      expected_count: 2,
      confirm: true,
    });

    expect(state.deleteRecordCalls).toHaveLength(2);
    expect(result.structuredContent?.requires_confirmation).toBeUndefined();
  });

  it('expected_count mismatch aborts even with confirm=true', async () => {
    const state: StubState = { deleteRecordCalls: [], executeBatchCalls: [] };
    const services = buildStubServices(state);
    const server = buildFakeServer();
    registerWriteTools(server as never, services);

    const handler = getHandler(server, 'bpm_delete_by_filter');
    const result = await handler({
      collection: 'Contact',
      filter: "Name eq 'X'",
      expected_count: 5,
      confirm: true,
    });

    expect(state.deleteRecordCalls).toHaveLength(0);
    expect(result.isError).toBe(true);
  });
});

describe('bpm_batch_delete confirmation', () => {
  it('without confirm returns a preview and does not call executeBatch', async () => {
    const state: StubState = { deleteRecordCalls: [], executeBatchCalls: [] };
    const services = buildStubServices(state);
    const server = buildFakeServer();
    registerBatchTools(server as never, services);

    const handler = getHandler(server, 'bpm_batch_delete');
    const result = await handler({ collection: 'Contact', ids: ['id-1', 'id-2', 'id-3'] });

    expect(state.executeBatchCalls).toHaveLength(0);
    expect(result.structuredContent?.requires_confirmation).toBe(true);
    expect(result.structuredContent?.count).toBe(3);
  });

  it('with confirm=true executes the batch delete', async () => {
    const state: StubState = { deleteRecordCalls: [], executeBatchCalls: [] };
    const services = buildStubServices(state);
    const server = buildFakeServer();
    registerBatchTools(server as never, services);

    const handler = getHandler(server, 'bpm_batch_delete');
    const result = await handler({ collection: 'Contact', ids: ['id-1', 'id-2'], confirm: true });

    expect(state.executeBatchCalls).toHaveLength(1);
    expect(state.executeBatchCalls[0]).toHaveLength(2);
    expect(result.structuredContent?.requires_confirmation).toBeUndefined();
  });
});
