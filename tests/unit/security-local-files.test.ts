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
import { runWithAuth } from '../../src/auth/request-context.js';

vi.mock('node:fs/promises', async (orig) => {
  const actual = await orig<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile), writeFile: vi.fn(actual.writeFile) };
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
  let createdImageId: string | undefined;
  const services = {
    config: {
      bpmsoft_url: 'https://bpm.example',
      odata_version: 4,
      platform: 'net8',
      max_file_size: maxSize,
      file_root: process.env.BPMSOFT_FILE_ROOT ?? root,
    },
    authManager: { ensureAuthenticated: vi.fn(async () => undefined) },
    metadataManager: {
      resolveCollectionReference: async (n: string) => ({ name: n }),
      resolveFieldReference: async (_collection: string, name: string) => ({ name }),
      getEntityMetadata: async () => ({
        properties: [
          { name: 'Id', type: 'Edm.Guid' },
          { name: 'Name', type: 'Edm.String' },
          { name: 'MimeType', type: 'Edm.String' },
          { name: 'Data', type: 'Edm.Stream' },
          { name: 'Photo', type: 'Edm.Stream' },
        ],
      }),
    },
    lookupResolver: {
      resolveDataLookups: async (_collection: string, data: Record<string, unknown>) => ({ data, notes: [] }),
    },
    odataClient: {
      async putFieldBinary(_c: string, _i: string, _f: string, b: Buffer) {
        puts.push(b);
      },
      async getFieldBinary(collection: string, id: string) {
        if (collection === 'SysImage' && id === createdImageId) return Buffer.alloc(0);
        return Buffer.from('hello');
      },
      async getRecord() {
        return { Id: UUID, Name: 'hello.txt', MimeType: 'text/plain' };
      },
      async createRecord(_collection: string, data: Record<string, unknown>, options?: { id?: string }) {
        createdImageId = options?.id ?? UUID;
        return { ...data, Id: createdImageId };
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
  return {
    h:
      (n: string): Handler =>
      (args) =>
        process.env.MCP_TRANSPORT === 'stdio'
          ? handlers.get(n)!(args)
          : runWithAuth(
              { csrfToken: 'test-csrf', cookies: new Map([['BPMSESSIONID', 'test-session']]) },
              () => handlers.get(n)!(args)
            ),
    puts,
  };
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
  vi.mocked(fsp.writeFile).mockClear();
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

describe('bpm_download_file isError', () => {
  it('failed local write → isError true with the save error in the text', async () => {
    process.env.MCP_TRANSPORT = 'stdio';
    const { h } = setup();
    vi.mocked(fsp.writeFile).mockRejectedValueOnce(new Error('EACCES: permission denied'));
    const r = await h('bpm_download_file')({ image_id: UUID, save_path: '/tmp/bpm-unwritable.bin' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('EACCES: permission denied');
  });

  it('successful local save → not an error', async () => {
    process.env.MCP_TRANSPORT = 'stdio';
    const { h } = setup();
    const target = join(root, 'ok.bin');
    const r = await h('bpm_download_file')({ image_id: UUID, save_path: target });
    expect(r.isError).toBe(false);
    expect(r.content[0].text).toContain('Сохранён');
  });

  it('download without save_path → not an error', async () => {
    process.env.MCP_TRANSPORT = 'stdio';
    const { h } = setup();
    const r = await h('bpm_download_file')({ image_id: UUID, return_base64: true });
    expect(r.isError).toBe(false);
  });
});

describe('buildRebindingOptions', () => {
  it('loopback bind honors the exact configured hosts and origins', () => {
    process.env.MCP_ALLOWED_HOSTS = 'mcp.example:443';
    process.env.MCP_ALLOWED_ORIGINS = 'https://app.example';
    const o = buildRebindingOptions('127.0.0.1', 8007);
    expect(o.allowedHosts).toEqual(['mcp.example:443']);
    expect(o.allowedOrigins).toEqual(['https://app.example']);
  });

  it('wildcard bind requires an explicit Host allowlist', () => {
    delete process.env.MCP_ALLOWED_HOSTS;
    delete process.env.MCP_ALLOWED_ORIGINS;
    expect(() => buildRebindingOptions('0.0.0.0', 8007)).toThrow('MCP_ALLOWED_HOSTS');
  });

  it('wildcard bind with MCP_ALLOWED_HOSTS enforces the list', () => {
    process.env.MCP_ALLOWED_HOSTS = 'mcp.example';
    const o = buildRebindingOptions('0.0.0.0', 8007);
    expect(o.allowedHosts).toContain('mcp.example');
    expect(o.allowedHosts).toEqual(['mcp.example']);
  });
});
