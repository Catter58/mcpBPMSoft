/**
 * Unit tests for MCP prompts (registry + callbacks).
 */

import { describe, it, expect, vi } from 'vitest';
import type { GetPromptResult } from '@modelcontextprotocol/sdk/types.js';
import { PROMPTS } from '../../src/prompts/registry.js';
import { registerPrompts } from '../../src/prompts/index.js';
import type { ServiceContainer } from '../../src/tools/init-tool.js';

type PromptCallback = (
  args: Record<string, string>,
  extra: unknown
) => Promise<GetPromptResult> | GetPromptResult;

interface MockServer {
  registerPrompt: ReturnType<typeof vi.fn>;
}

function buildMockServer(): MockServer {
  return {
    registerPrompt: vi.fn(),
  };
}

function getCallback(server: MockServer, name: string): PromptCallback {
  const call = server.registerPrompt.mock.calls.find((c: unknown[]) => c[0] === name);
  if (!call) throw new Error(`Prompt ${name} was not registered`);
  return call[2] as PromptCallback;
}

function extractText(result: GetPromptResult): string {
  const msg = result.messages[0];
  expect(msg).toBeDefined();
  expect(msg.role).toBe('user');
  const content = msg.content;
  if ('type' in content && content.type === 'text') {
    return content.text;
  }
  throw new Error('Expected text content');
}

const stubServices = { initialized: true } as unknown as ServiceContainer;

describe('PROMPTS registry', () => {
  it('contains exactly 6 prompts with required metadata', () => {
    expect(PROMPTS).toHaveLength(6);
    for (const p of PROMPTS) {
      expect(p.name).toBeTruthy();
      expect(p.title).toBeTruthy();
      expect(p.description).toBeTruthy();
      expect(p.blurb).toBeTruthy();
    }
  });

  it('exposes the expected prompt names', () => {
    const names = PROMPTS.map((p) => p.name).sort();
    expect(names).toEqual(
      [
        'cleanup_duplicates_check',
        'create_contact_flow',
        'getting_started',
        'pipeline_analysis',
        'quick_search',
        'weekly_report',
      ].sort()
    );
  });
});

describe('registerPrompts callbacks', () => {
  it('registers all 6 prompts on the server', () => {
    const server = buildMockServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPrompts(server as any, stubServices);
    expect(server.registerPrompt).toHaveBeenCalledTimes(6);
  });

  it('getting_started returns a non-empty user text', async () => {
    const server = buildMockServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPrompts(server as any, stubServices);
    const cb = getCallback(server, 'getting_started');
    const res = await cb({}, undefined);
    const text = extractText(res);
    expect(text.length).toBeGreaterThan(50);
    expect(text).toContain('BPMSoft');
    expect(text).toContain('Contact');
  });

  it('quick_search interpolates {query} into the message', async () => {
    const server = buildMockServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPrompts(server as any, stubServices);
    const cb = getCallback(server, 'quick_search');
    const res = await cb({ query: 'Иванов' }, undefined);
    const text = extractText(res);
    expect(text).toContain('Иванов');
    expect(text).toContain('bpm_search_unified');
  });

  it('create_contact_flow renders required name into the message', async () => {
    const server = buildMockServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPrompts(server as any, stubServices);
    const cb = getCallback(server, 'create_contact_flow');
    const res = await cb({ name: 'Пётр Петров' }, undefined);
    const text = extractText(res);
    expect(text).toContain('Пётр Петров');
    expect(text).toContain('bpm_register_contact');
  });

  it('create_contact_flow includes optional account/email/phone when provided', async () => {
    const server = buildMockServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPrompts(server as any, stubServices);
    const cb = getCallback(server, 'create_contact_flow');
    const res = await cb(
      { name: 'A', account: 'ACME', email: 'a@b.c', phone: '+7' },
      undefined
    );
    const text = extractText(res);
    expect(text).toContain('ACME');
    expect(text).toContain('a@b.c');
    expect(text).toContain('+7');
  });

  it('weekly_report defaults to 7 days when period_days is empty', async () => {
    const server = buildMockServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPrompts(server as any, stubServices);
    const cb = getCallback(server, 'weekly_report');
    const res = await cb({}, undefined);
    const text = extractText(res);
    expect(text).toContain('7');
    expect(text).toContain('Activity');
  });
});
