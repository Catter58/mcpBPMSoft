/**
 * Unit tests for the two-step delete confirmation flow (confirm=true param)
 * across bpm_delete_record, bpm_delete_by_filter, bpm_batch_delete, bpm_field_delete.
 */

import { describe, it, expect, vi } from 'vitest';
import { registerWriteTools } from '../../src/tools/write-tools.js';
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
}

function buildStubServices(state: StubState): ServiceContainer {
  const odataClient = {
    async getRecord(collection: string, id: string) {
      return { Id: id, Name: `Test ${collection} ${id}` };
    },
    async deleteRecord(collection: string, id: string) {
      state.deleteRecordCalls.push({ collection, id });
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
    const state: StubState = { deleteRecordCalls: [] };
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
    const state: StubState = { deleteRecordCalls: [] };
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
