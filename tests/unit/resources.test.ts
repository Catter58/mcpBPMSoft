/**
 * Unit tests for MCP resources.
 *
 * Mocks the McpServer surface (registerResource) and ServiceContainer
 * dependencies (metadataManager, odataClient) to keep the test offline.
 */

import { describe, it, expect, vi } from 'vitest';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerResources } from '../../src/resources/index.js';
import type { ServiceContainer } from '../../src/tools/init-tool.js';
import type { EntityMetadata } from '../../src/types/index.js';

type StaticReadCallback = (uri: URL, extra: unknown) => Promise<ReadResourceResult>;
type TemplateReadCallback = (
  uri: URL,
  variables: Record<string, string | string[]>,
  extra: unknown
) => Promise<ReadResourceResult>;

interface MockServer {
  registerResource: ReturnType<typeof vi.fn>;
}

function buildMockServer(): MockServer {
  return {
    registerResource: vi.fn(),
  };
}

function buildContactMeta(): EntityMetadata {
  return {
    name: 'Contact',
    collectionName: 'Contact',
    properties: [
      { name: 'Id', type: 'Edm.Guid', nullable: false, isLookup: false },
      {
        name: 'Name',
        type: 'Edm.String',
        nullable: false,
        isLookup: false,
        caption: 'ФИО',
      },
      {
        name: 'AccountId',
        type: 'Edm.Guid',
        nullable: true,
        isLookup: true,
        lookupCollection: 'Account',
        lookupDisplayColumn: 'Name',
        caption: 'Контрагент',
      },
    ],
    lookupFields: ['AccountId'],
    cachedAt: Date.now(),
  };
}

function findRegistration(server: MockServer, name: string): {
  callback: StaticReadCallback | TemplateReadCallback;
  uriOrTemplate: string | ResourceTemplate;
} {
  const call = server.registerResource.mock.calls.find((c: unknown[]) => c[0] === name);
  if (!call) throw new Error(`Resource ${name} was not registered`);
  return {
    uriOrTemplate: call[1] as string | ResourceTemplate,
    callback: call[3] as StaticReadCallback | TemplateReadCallback,
  };
}

describe('registerResources', () => {
  it('registers all 4 resources/templates', () => {
    const server = buildMockServer();
    const services = { initialized: true } as unknown as ServiceContainer;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerResources(server as any, services);
    expect(server.registerResource).toHaveBeenCalledTimes(4);
    const names = server.registerResource.mock.calls.map((c: unknown[]) => c[0]);
    expect(names).toContain('bpmsoft_collections');
    expect(names).toContain('bpmsoft_collection');
    expect(names).toContain('bpmsoft_schema');
    expect(names).toContain('bpmsoft_entity');
  });

  it('bpmsoft://collections returns application/json with collections array', async () => {
    const server = buildMockServer();
    const getEntitySets = vi.fn().mockResolvedValue([
      { name: 'Contact', entityType: 'BPMSoft.Contact' },
      { name: 'Account', entityType: 'BPMSoft.Account' },
    ]);
    const services = {
      initialized: true,
      metadataManager: { getEntitySets },
    } as unknown as ServiceContainer;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerResources(server as any, services);
    const reg = findRegistration(server, 'bpmsoft_collections');
    expect(reg.uriOrTemplate).toBe('bpmsoft://collections');
    const cb = reg.callback as StaticReadCallback;
    const res = await cb(new URL('bpmsoft://collections'), undefined);
    expect(getEntitySets).toHaveBeenCalledOnce();
    expect(res.contents).toHaveLength(1);
    const content = res.contents[0];
    expect(content.mimeType).toBe('application/json');
    const parsed = JSON.parse((content as { text: string }).text);
    expect(parsed.count).toBe(2);
    expect(parsed.collections).toEqual([
      { name: 'Contact', entityType: 'BPMSoft.Contact' },
      { name: 'Account', entityType: 'BPMSoft.Account' },
    ]);
  });

  it('throws when called before bpm_init', async () => {
    const server = buildMockServer();
    const services = { initialized: false } as unknown as ServiceContainer;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerResources(server as any, services);
    const reg = findRegistration(server, 'bpmsoft_collections');
    const cb = reg.callback as StaticReadCallback;
    await expect(cb(new URL('bpmsoft://collections'), undefined)).rejects.toThrow(
      /bpm_init/
    );
  });

  it('bpmsoft://collection/{name} returns schema card with property fields', async () => {
    const server = buildMockServer();
    const getEntityMetadata = vi.fn().mockResolvedValue(buildContactMeta());
    const getCount = vi.fn().mockResolvedValue(42);
    const services = {
      initialized: true,
      metadataManager: { getEntityMetadata, resolveCollectionReference: vi.fn() },
      odataClient: { getCount },
    } as unknown as ServiceContainer;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerResources(server as any, services);
    const reg = findRegistration(server, 'bpmsoft_collection');
    expect(reg.uriOrTemplate).toBeInstanceOf(ResourceTemplate);
    const cb = reg.callback as TemplateReadCallback;

    const res = await cb(
      new URL('bpmsoft://collection/Contact'),
      { name: 'Contact' },
      undefined
    );
    expect(getEntityMetadata).toHaveBeenCalledWith('Contact');
    expect(getCount).toHaveBeenCalledWith('Contact');
    expect(res.contents).toHaveLength(1);
    const content = res.contents[0];
    expect(content.mimeType).toBe('application/json');
    const parsed = JSON.parse((content as { text: string }).text);
    expect(parsed.collection).toBe('Contact');
    expect(parsed.entity).toBe('Contact');
    expect(parsed.record_count).toBe(42);
    expect(Array.isArray(parsed.properties)).toBe(true);
    expect(parsed.properties).toHaveLength(3);
    const nameProp = parsed.properties.find((p: { name: string }) => p.name === 'Name');
    expect(nameProp.caption).toBe('ФИО');
    expect(nameProp.required).toBe(true);
    const accountProp = parsed.properties.find((p: { name: string }) => p.name === 'AccountId');
    expect(accountProp.isLookup).toBe(true);
    expect(accountProp.lookup).toEqual({ collection: 'Account', displayColumn: 'Name' });
  });

  it('bpmsoft://collection/{name} returns markdown with suggestions when collection missing', async () => {
    const server = buildMockServer();
    const getEntityMetadata = vi.fn().mockRejectedValue(new Error('not found'));
    const resolveCollectionReference = vi.fn().mockResolvedValue({
      name: null,
      suggestions: ['Contact', 'ContactCommunication'],
    });
    const services = {
      initialized: true,
      metadataManager: { getEntityMetadata, resolveCollectionReference },
      odataClient: { getCount: vi.fn() },
    } as unknown as ServiceContainer;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerResources(server as any, services);
    const reg = findRegistration(server, 'bpmsoft_collection');
    const cb = reg.callback as TemplateReadCallback;
    const res = await cb(
      new URL('bpmsoft://collection/Contakt'),
      { name: 'Contakt' },
      undefined
    );
    expect(res.contents).toHaveLength(1);
    expect(res.contents[0].mimeType).toBe('text/markdown');
    const text = (res.contents[0] as { text: string }).text;
    expect(text).toContain('Contakt');
    expect(text).toContain('Contact');
  });
});
