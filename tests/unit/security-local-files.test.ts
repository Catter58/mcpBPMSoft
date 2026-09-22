/**
 * Security: local file access in stream tools (path guard, base64 alternatives,
 * size check before read) and DNS-rebinding options of the HTTP transport.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkLocalPath, registerStreamTools } from '../../src/tools/stream-tools.js';
import { buildRebindingOptions } from '../../src/server/http-transport.js';
import type { ServiceContainer } from '../../src/tools/init-tool.js';

vi.mock('node:fs/promises', async (orig) => {
  const actual = await orig<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

const UUID = '11111111-2222-3333-4444-555555555555';

function setup(maxSize = 1024) {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool(name: string, _meta: unknown, handler: Handler) {
      handlers.set(name, handler);
    },
  };
  const puts: Buffer[] = [];
  const services = {
    config: { url: 'https://bpm.example', odata_version: 4, platform: 'net8', max_file_size: maxSize },
    authManager: { ensureAuthenticated: vi.fn(async () => undefined) },
    metadataManager: { resolveCollectionReference: async (n: string) => ({ name: n }) },
    odataClient: {
      async putFieldBinary(_c: string, _i: string, _f: string, b: Buffer) {
        puts.push(b);
      },
      async getFieldBinary() {
        return Buffer.from('hello');
      },
      async createRecord() {
        return { Id: UUID };
      },
    },
    httpClient: {
      async request(req: { body?: Buffer }) {
        if (req.body) puts.push(req.body);
        return { data: Buffer.from('hello') };
      },
    },
    initialized: true,
  } as unknown as ServiceContainer;
  registerStreamTools(server as never, services);
  return { h: (n: string) => handlers.get(n)!, puts };
}

let root: string;
let outside: string;
const envBackup = { ...process.env };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'bpm-root-'));
  outside = await mkdtemp(join(tmpdir(), 'bpm-out-'));
  delete process.env.MCP_TRANSPORT;
  delete process.env.BPMSOFT_FILE_ROOT;
  vi.mocked(fsp.readFile).mockClear();
});

afterEach(async () => {
  process.env = { ...envBackup };
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('checkLocalPath', () => {
  it('refuses any path in HTTP mode without BPMSOFT_FILE_ROOT', async () => {
    const r = await checkLocalPath('/etc/passwd', false);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('BPMSOFT_FILE_ROOT');
  });

  it('allows any path in stdio mode', async () => {
    process.env.MCP_TRANSPORT = 'stdio';
    expect(await checkLocalPath('/etc/passwd', false)).toEqual({ ok: true, path: '/etc/passwd' });
  });

  it('allows a path inside the root and refuses one outside', async () => {
    process.env.BPMSOFT_FILE_ROOT = root;
    await writeFile(join(root, 'a.txt'), 'x');
    await writeFile(join(outside, 'b.txt'), 'x');
    expect((await checkLocalPath(join(root, 'a.txt'), false)).ok).toBe(true);
    expect((await checkLocalPath('a.txt', false)).ok).toBe(true);
    expect((await checkLocalPath(join(outside, 'b.txt'), false)).ok).toBe(false);
    expect((await checkLocalPath('../' + outside.split('/').pop() + '/b.txt', false)).ok).toBe(false);
  });

  it('refuses symlinks that escape the root (read and write)', async () => {
    process.env.BPMSOFT_FILE_ROOT = root;
    await writeFile(join(outside, 'secret'), 'x');
    await symlink(join(outside, 'secret'), join(root, 'link'));
    await symlink(outside, join(root, 'dirlink'));
    expect((await checkLocalPath(join(root, 'link'), false)).ok).toBe(false);
    expect((await checkLocalPath(join(root, 'link'), true)).ok).toBe(false);
    expect((await checkLocalPath(join(root, 'dirlink', 'new.bin'), true)).ok).toBe(false);
    expect((await checkLocalPath(join(root, 'new.bin'), true)).ok).toBe(true);
  });
});

describe('upload tools', () => {
  it('bpm_field_upload refuses file_path outside root and does not read it', async () => {
    const { h, puts } = setup();
    const r = await h('bpm_field_upload')({
      collection: 'Contact',
      id: UUID,
      field: 'Photo',
      file_path: '/etc/hosts',
    });
    expect(r.isError).toBe(true);
    expect(fsp.readFile).not.toHaveBeenCalled();
    expect(puts).toHaveLength(0);
  });

  it('bpm_field_upload accepts content_base64', async () => {
    const { h, puts } = setup();
    const r = await h('bpm_field_upload')({
      collection: 'Contact',
      id: UUID,
      field: 'Photo',
      content_base64: Buffer.from('hello').toString('base64'),
    });
    expect(r.isError).toBeUndefined();
    expect(puts[0].toString()).toBe('hello');
  });

  it('requires exactly one of file_path / content_base64', async () => {
    const { h } = setup();
    const r = await h('bpm_field_upload')({ collection: 'Contact', id: UUID, field: 'Photo' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('ровно один');
  });

  it('checks size before reading the file', async () => {
    process.env.BPMSOFT_FILE_ROOT = root;
    await writeFile(join(root, 'big.bin'), Buffer.alloc(2048));
    const { h, puts } = setup(1024);
    const r = await h('bpm_field_upload')({
      collection: 'Contact',
      id: UUID,
      field: 'Photo',
      file_path: join(root, 'big.bin'),
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('превышает лимит');
    expect(fsp.readFile).not.toHaveBeenCalled();
    expect(puts).toHaveLength(0);
  });

  it('rejects oversized content_base64', async () => {
    const { h } = setup(4);
    const r = await h('bpm_upload_file')({
      name: 'a.txt',
      content_base64: Buffer.from('hello').toString('base64'),
    });
    expect(r.isError).toBe(true);
  });

  it('bpm_upload_file requires name with content_base64 and uploads it', async () => {
    const { h, puts } = setup();
    const b64 = Buffer.from('hello').toString('base64');
    expect((await h('bpm_upload_file')({ content_base64: b64 })).isError).toBe(true);
    const r = await h('bpm_upload_file')({ name: 'a.txt', content_base64: b64 });
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent?.size_bytes).toBe(5);
    expect(puts[0].toString()).toBe('hello');
  });

  it('bpm_upload_file reads a file inside the root', async () => {
    process.env.BPMSOFT_FILE_ROOT = root;
    await writeFile(join(root, 'a.txt'), 'hello');
    const { h, puts } = setup();
    const r = await h('bpm_upload_file')({ file_path: join(root, 'a.txt') });
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent?.name).toBe('a.txt');
    expect(puts[0].toString()).toBe('hello');
  });
});

describe('download tools', () => {
  it('bpm_field_download refuses save_path outside root and writes nothing', async () => {
    process.env.BPMSOFT_FILE_ROOT = root;
    const { h } = setup();
    const target = join(outside, 'x.bin');
    const r = await h('bpm_field_download')({
      collection: 'Contact',
      id: UUID,
      field: 'Photo',
      save_path: target,
    });
    expect(r.isError).toBe(true);
    await expect(readFile(target)).rejects.toThrow();
  });

  it('bpm_field_download saves inside root and returns base64 in structuredContent only', async () => {
    process.env.BPMSOFT_FILE_ROOT = root;
    const { h } = setup();
    const target = join(root, 'x.bin');
    const r = await h('bpm_field_download')({
      collection: 'Contact',
      id: UUID,
      field: 'Photo',
      save_path: target,
      return_base64: true,
    });
    expect(r.isError).toBeUndefined();
    expect((await readFile(target)).toString()).toBe('hello');
    const b64 = Buffer.from('hello').toString('base64');
    expect(r.structuredContent?.content_base64).toBe(b64);
    expect(r.content[0].text).not.toContain(b64);
  });
});

describe('buildRebindingOptions', () => {
  it('loopback bind: default hosts plus env extras and origins', () => {
    process.env.MCP_ALLOWED_HOSTS = 'mcp.example:443';
    process.env.MCP_ALLOWED_ORIGINS = 'https://app.example';
    const o = buildRebindingOptions('127.0.0.1', 8007);
    expect(o.allowedHosts).toEqual(['127.0.0.1:8007', 'localhost:8007', 'mcp.example:443']);
    expect(o.allowedOrigins).toEqual(['https://app.example']);
  });

  it('wildcard bind without MCP_ALLOWED_HOSTS skips host check with a warning', () => {
    delete process.env.MCP_ALLOWED_HOSTS;
    delete process.env.MCP_ALLOWED_ORIGINS;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const o = buildRebindingOptions('0.0.0.0', 8007);
    expect(o.allowedHosts).toBeUndefined();
    expect(o.allowedOrigins).toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('wildcard bind with MCP_ALLOWED_HOSTS enforces the list', () => {
    process.env.MCP_ALLOWED_HOSTS = 'mcp.example';
    const o = buildRebindingOptions('0.0.0.0', 8007);
    expect(o.allowedHosts).toContain('mcp.example');
    expect(o.allowedHosts).toContain('localhost:8007');
  });
});
