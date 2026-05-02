/**
 * Unit tests for the bpm_post_feed handler.
 *
 * The tool is registered through registerProcessTools onto a FakeServer that
 * captures the handler closure. Stubbed services validate that:
 *   1. The body sent to SocialMessage matches the documented shape.
 *   2. parent_id propagates as ParentId when present.
 */

import { describe, it, expect, vi } from 'vitest';
import { registerProcessTools } from '../../src/tools/process-tools.js';
import type { ServiceContainer } from '../../src/tools/init-tool.js';

interface RegisteredTool {
  name: string;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

interface FakeServer {
  registered: RegisteredTool[];
  registerTool: (
    name: string,
    _meta: unknown,
    handler: (args: Record<string, unknown>) => Promise<unknown>
  ) => void;
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
  createCalls: Array<{ collection: string; data: Record<string, unknown> }>;
}

function buildStubServices(state: StubState): ServiceContainer {
  const odataClient = {
    async createRecord(collection: string, data: Record<string, unknown>) {
      state.createCalls.push({ collection, data });
      return { Id: 'feed-1', ...data };
    },
  };

  const metadataManager = {
    async resolveCollectionReference(query: string) {
      return { name: query };
    },
  };

  const authManager = { ensureAuthenticated: vi.fn(async () => undefined) };

  return {
    config: null!,
    httpClient: null!,
    authManager: authManager as unknown as ServiceContainer['authManager'],
    odataClient: odataClient as unknown as ServiceContainer['odataClient'],
    metadataManager: metadataManager as unknown as ServiceContainer['metadataManager'],
    lookupResolver: null! as ServiceContainer['lookupResolver'],
    processEngine: null! as ServiceContainer['processEngine'],
    initialized: true,
  };
}

function getPostFeedHandler(server: FakeServer): (args: Record<string, unknown>) => Promise<unknown> {
  const tool = server.registered.find((r) => r.name === 'bpm_post_feed');
  if (!tool) throw new Error('bpm_post_feed not registered');
  return tool.handler;
}

describe('bpm_post_feed', () => {
  it('sends Message/EntitySchemaName/EntityId to SocialMessage', async () => {
    const state: StubState = { createCalls: [] };
    const services = buildStubServices(state);
    const server = buildFakeServer();
    registerProcessTools(server as never, services);

    const handler = getPostFeedHandler(server);
    await handler({
      collection: 'Contact',
      id: '11111111-2222-3333-4444-555555555555',
      message: 'Hello feed',
    });

    expect(state.createCalls).toHaveLength(1);
    const call = state.createCalls[0];
    expect(call.collection).toBe('SocialMessage');
    expect(call.data).toEqual({
      Message: 'Hello feed',
      EntitySchemaName: 'Contact',
      EntityId: '11111111-2222-3333-4444-555555555555',
    });
    expect(call.data.ParentId).toBeUndefined();
  });

  it('adds ParentId when parent_id is provided', async () => {
    const state: StubState = { createCalls: [] };
    const services = buildStubServices(state);
    const server = buildFakeServer();
    registerProcessTools(server as never, services);

    const handler = getPostFeedHandler(server);
    await handler({
      collection: 'Contact',
      id: '11111111-2222-3333-4444-555555555555',
      message: 'Reply text',
      parent_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });

    expect(state.createCalls).toHaveLength(1);
    const call = state.createCalls[0];
    expect(call.collection).toBe('SocialMessage');
    expect(call.data).toEqual({
      Message: 'Reply text',
      EntitySchemaName: 'Contact',
      EntityId: '11111111-2222-3333-4444-555555555555',
      ParentId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
  });
});
