import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm, mkdir, symlink, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceContainer } from '../../src/tools/init-tool.js';
import { registerStreamTools } from '../../src/tools/stream-tools.js';
import { BpmApiError } from '../../src/utils/errors.js';
import { ODataClient } from '../../src/client/odata-client.js';
import { runWithAuth } from '../../src/auth/request-context.js';
import { buildConfig } from '../../src/config.js';
import { LookupResolver } from '../../src/lookup/lookup-resolver.js';

const A = 'aaaaaaaa-1111-4111-8111-111111111111';
let directory: string;
let file: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mcp-stream-safety-'));
  file = join(directory, 'example.bin');
  await writeFile(file, 'file-content');
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
function setup() {
  const odataClient = {
    getRecord: vi.fn(async (_collection: string, id: string) => ({
      Id: id,
      Name: 'example.bin',
      MimeType: 'application/octet-stream',
    })),
    createRecord: vi.fn(
      async (_collection: string, data: Record<string, unknown>, options?: { id?: string }) => ({
        ...data,
        Id: options?.id ?? A,
      })
    ),
    getFieldBinary: vi.fn(async () => Buffer.alloc(0)),
    putFieldBinary: vi.fn(async () => undefined),
    deleteFieldBinary: vi.fn(async () => undefined),
    updateRecord: vi.fn(async () => undefined),
    assertExpectedEtag: vi.fn(async () => undefined),
  };
  const services = {
    initialized: true,
    config: { bpmsoft_url: 'https://crm.example.test', username: 'tester', max_file_size: 1024 },
    authManager: { ensureAuthenticated: vi.fn(async () => undefined) },
    odataClient,
    metadataManager: {
      resolveCollectionReference: vi.fn(async (name: string) => ({ name })),
      resolveFieldReference: vi.fn(async (_collection: string, name: string) => ({ name })),
      getEntityMetadata: vi.fn(async (collection: string) => ({
        properties:
          collection === 'SysImage'
            ? [
                { name: 'Data', type: 'Edm.Binary' },
                { name: 'Name', type: 'Edm.String' },
                { name: 'MimeType', type: 'Edm.String', required: true },
              ]
            : [
                { name: 'PhotoId', type: 'Edm.Guid', isLookup: true, lookupCollection: 'SysImage' },
                { name: 'Data', type: 'Edm.Binary' },
              ],
      })),
    },
    lookupResolver: {
      resolveDataLookups: vi.fn(async (_collection: string, data: Record<string, unknown>) => ({
        data,
        notes: [],
      })),
    },
  } as unknown as ServiceContainer;
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<CallToolResult>>();
  registerStreamTools(
    {
      registerTool: (
        name: string,
        _meta: unknown,
        handler: (args: Record<string, unknown>) => Promise<CallToolResult>
      ) => handlers.set(name, handler),
    } as never,
    services
  );
  return {
    services,
    odataClient,
    call: (name: string, args: Record<string, unknown>) => handlers.get(name)!(args),
  };
}
describe('SysImage upload safety', () => {
  it('uploads and links a new image with the actual resolver without resolving a not-yet-created image', async () => {
    const env = setup();
    env.services.metadataManager.getLookupInfo = vi.fn(async () => null) as never;
    env.services.lookupResolver = new LookupResolver(
      env.services.config,
      env.services.odataClient,
      env.services.metadataManager
    );
    const result = await env.call('bpm_upload_file', {
      file_path: file,
      target_collection: 'Contact',
      target_id: A,
      target_field: 'PhotoId',
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.linked).toBe(true);
    expect(env.odataClient.updateRecord).toHaveBeenCalledWith(
      'Contact',
      A,
      { PhotoId: result.structuredContent?.image_id },
      { expectedEtag: undefined }
    );
    expect(env.odataClient.getRecord.mock.calls.every((call) => call[0] === 'Contact')).toBe(true);
  });
  it('rejects an ordinary UUID field as a file-link target before creating anything', async () => {
    const env = setup();
    env.services.metadataManager.getEntityMetadata = vi.fn(async (collection: string) => ({
      properties:
        collection === 'SysImage'
          ? [
              { name: 'Data', type: 'Edm.Binary' },
              { name: 'Name', type: 'Edm.String' },
            ]
          : [{ name: 'Id', type: 'Edm.Guid', isLookup: false }],
    })) as never;
    const result = await env.call('bpm_upload_file', {
      file_path: file,
      target_collection: 'Contact',
      target_id: A,
      target_field: 'Id',
    });
    expect(result.isError).toBe(true);
    expect(env.odataClient.createRecord).not.toHaveBeenCalled();
    expect(env.odataClient.updateRecord).not.toHaveBeenCalled();
  });
  it('determines required MIME metadata from the filename and validates explicit overrides', async () => {
    const env = setup();
    const result = await env.call('bpm_upload_file', { file_path: file, name: 'notes.txt' });
    expect(result.isError).toBeUndefined();
    expect(env.odataClient.createRecord.mock.calls[0][1]).toEqual({
      Name: 'notes.txt',
      MimeType: 'text/plain',
    });
    expect(result.structuredContent?.mime_type).toBe('text/plain');
    for (const mime of ['', 'invalid', 'text/plain\r\nInjected: value'])
      expect((await env.call('bpm_upload_file', { file_path: file, mime_type: mime })).isError).toBe(true);
    expect(env.odataClient.createRecord).toHaveBeenCalledTimes(1);
    const override = await env.call('bpm_upload_file', { file_path: file, mime_type: 'image/svg+xml' });
    expect(override.structuredContent?.mime_type).toBe('image/svg+xml');
  });
  it('repairs legacy blank MIME before reading binary data on an explicit resume', async () => {
    const env = setup();
    env.odataClient.getRecord.mockResolvedValue({ Id: A, Name: 'example.bin', MimeType: '' });
    env.odataClient.getFieldBinary.mockImplementation(async () => {
      expect(env.odataClient.updateRecord).toHaveBeenCalledWith(
        'SysImage',
        A,
        { MimeType: 'application/octet-stream' },
        { expectedEtag: undefined }
      );
      return Buffer.from('file-content');
    });
    const result = await env.call('bpm_upload_file', { file_path: file, image_id: A });
    expect(result.isError).toBeUndefined();
    expect(env.odataClient.createRecord).not.toHaveBeenCalled();
    expect(env.odataClient.putFieldBinary).not.toHaveBeenCalled();
    expect(result.structuredContent?.outcomes).toEqual([
      expect.objectContaining({ step: 'create_image', state: 'succeeded' }),
      expect.objectContaining({ step: 'prepare_image', state: 'succeeded' }),
      expect.objectContaining({ step: 'upload_data', state: 'succeeded' }),
    ]);
  });
  it('repairs a legacy keyed image without invoking conflicting create reconciliation', async () => {
    const env = setup();
    env.odataClient.getRecord.mockImplementation(async (_collection, id) => ({
      Id: id,
      Name: 'example.bin',
      MimeType: '',
    }));
    const result = await env.call('bpm_upload_file', { file_path: file, idempotency_key: 'legacy-image' });
    expect(result.isError).toBeUndefined();
    expect(env.odataClient.createRecord).not.toHaveBeenCalled();
    expect(env.odataClient.updateRecord).toHaveBeenCalledWith(
      'SysImage',
      expect.any(String),
      { MimeType: 'application/octet-stream' },
      { expectedEtag: undefined }
    );
  });
  it('rejects conflicting explicit or keyed MIME and preserves existing MIME on an ordinary resume', async () => {
    const env = setup();
    env.odataClient.getRecord.mockResolvedValue({ Id: A, Name: 'example.bin', MimeType: 'image/png' });
    for (const extra of [{ image_id: A, mime_type: 'image/jpeg' }, { idempotency_key: 'image-key' }]) {
      expect((await env.call('bpm_upload_file', { file_path: file, ...extra })).isError).toBe(true);
    }
    expect(env.odataClient.putFieldBinary).not.toHaveBeenCalled();
    expect(env.odataClient.updateRecord).not.toHaveBeenCalled();
    const result = await env.call('bpm_upload_file', { file_path: file, image_id: A });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.mime_type).toBe('image/png');
    expect(env.odataClient.updateRecord).not.toHaveBeenCalled();
  });
  it('rejects incomplete target before creating image or sending bytes', async () => {
    const env = setup();
    const result = await env.call('bpm_upload_file', { file_path: file, target_collection: 'Contact' });
    expect(result.isError).toBe(true);
    expect(env.odataClient.createRecord).not.toHaveBeenCalled();
    expect(env.odataClient.putFieldBinary).not.toHaveBeenCalled();
  });
  it('preflights link metadata and reports all successful steps', async () => {
    const env = setup();
    const result = await env.call('bpm_upload_file', {
      file_path: file,
      target_collection: 'Contact',
      target_id: A,
      target_field: 'PhotoId',
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.outcomes).toEqual([
      expect.objectContaining({ step: 'create_image', state: 'succeeded' }),
      expect.objectContaining({ step: 'upload_data', state: 'succeeded' }),
      expect.objectContaining({ step: 'link_image', state: 'succeeded' }),
    ]);
    expect(env.odataClient.putFieldBinary).toHaveBeenCalledWith(
      'SysImage',
      expect.any(String),
      'Data',
      Buffer.from('file-content'),
      { fieldType: 'Edm.Binary' }
    );
  });
  it('returns created UUID and unknown/unexecuted stages when binary transfer fails', async () => {
    const env = setup();
    env.odataClient.putFieldBinary.mockRejectedValue(
      new BpmApiError('Lost response', 502, 'SysImage', undefined, undefined, undefined, 'outcome_unknown')
    );
    const result = await env.call('bpm_upload_file', {
      file_path: file,
      target_collection: 'Contact',
      target_id: A,
      target_field: 'PhotoId',
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      image_id: expect.any(String),
      outcomes: [
        expect.objectContaining({ step: 'create_image', state: 'succeeded' }),
        expect.objectContaining({ step: 'upload_data', state: 'outcome_unknown' }),
        expect.objectContaining({ step: 'link_image', state: 'not_executed' }),
      ],
    });
    expect(env.odataClient.updateRecord).not.toHaveBeenCalled();
  });
  it('resumes by known UUID without creating a second SysImage or rewriting identical bytes', async () => {
    const env = setup();
    env.odataClient.getFieldBinary.mockResolvedValue(Buffer.from('file-content'));
    const result = await env.call('bpm_upload_file', {
      file_path: file,
      image_id: A,
      target_collection: 'Contact',
      target_id: A,
      target_field: 'PhotoId',
    });
    expect(result.isError).toBeUndefined();
    expect(env.odataClient.createRecord).not.toHaveBeenCalled();
    expect(env.odataClient.putFieldBinary).not.toHaveBeenCalled();
    expect(env.odataClient.updateRecord).toHaveBeenCalled();
  });
  it('rejects changed file content with the same idempotency key', async () => {
    const env = setup();
    env.odataClient.getFieldBinary.mockResolvedValue(Buffer.from('different-content'));
    const result = await env.call('bpm_upload_file', { file_path: file, idempotency_key: 'one-upload' });
    expect(result.isError).toBe(true);
    expect(env.odataClient.putFieldBinary).not.toHaveBeenCalled();
    expect(result.structuredContent?.image_id).toEqual(expect.any(String));
  });
  it('rejects oversized files before reading and writing remote data', async () => {
    const env = setup();
    env.services.config.max_file_size = 2;
    expect((await env.call('bpm_upload_file', { file_path: file })).isError).toBe(true);
    expect(env.odataClient.createRecord).not.toHaveBeenCalled();
  });
});
describe('binary field confirmation', () => {
  it.each([
    { version: 3, fieldType: 'Edm.Binary' },
    { version: 4, fieldType: 'Edm.Binary' },
    { version: 4, fieldType: 'Edm.Stream' },
  ] as const)(
    'routes registered raw methods by actual $fieldType metadata in OData $version',
    async ({ version, fieldType }) => {
      const env = setup();
      env.services.metadataManager.getEntityMetadata = vi.fn(async () => ({
        properties: [{ name: 'Data', type: fieldType }],
      })) as never;
      const request = vi.fn(async (params: { contentKind: string }) => ({
        status: 200,
        headers: {},
        data:
          params.contentKind === 'binary'
            ? Buffer.from('file-content')
            : version === 3
              ? { d: { Id: A } }
              : { Id: A },
      }));
      const config = buildConfig('https://crm.example.test', 'tester', 'example-password', {
        odata_version: version,
        platform: version === 3 ? 'netframework' : 'net8',
      });
      const client = new ODataClient(config, { request, setAllowedOrigin: vi.fn() } as never);
      env.services.odataClient = client;
      const args = { collection: 'Contact', id: A, field: 'Data' };
      expect((await env.call('bpm_field_upload', { ...args, file_path: file })).isError).toBeUndefined();
      expect((await env.call('bpm_field_download', args)).isError).toBeUndefined();
      const preview = await env.call('bpm_field_delete', args);
      expect(preview.isError).toBeUndefined();
      expect(
        (
          await env.call('bpm_field_delete', {
            ...args,
            confirm: true,
            confirmation_token: preview.structuredContent?.confirmation_token,
          })
        ).isError
      ).toBeUndefined();
      const binaryRequests = request.mock.calls
        .map((call) => call[0])
        .filter((params) => params.contentKind === 'binary');
      expect(binaryRequests).toHaveLength(5);
      expect(
        binaryRequests.every(
          (params) =>
            (params as { url?: string }).url ===
            `${client.buildRecordPath('Contact', A)}/Data${fieldType === 'Edm.Binary' ? '/$value' : ''}`
        )
      ).toBe(true);
    }
  );
  it('requires a token and rejects binary changes between preview and confirmation', async () => {
    const env = setup();
    const args = { collection: 'Contact', id: A, field: 'Data' };
    expect((await env.call('bpm_field_delete', { ...args, confirm: true })).isError).toBe(true);
    const preview = await env.call('bpm_field_delete', args);
    env.odataClient.getFieldBinary.mockResolvedValue(Buffer.from('changed'));
    expect(
      (
        await env.call('bpm_field_delete', {
          ...args,
          confirm: true,
          confirmation_token: preview.structuredContent?.confirmation_token,
        })
      ).isError
    ).toBe(true);
    expect(env.odataClient.deleteFieldBinary).not.toHaveBeenCalled();
  });
  it('rejects a Guid link field as a binary field', async () => {
    const env = setup();
    const result = await env.call('bpm_field_upload', {
      collection: 'Contact',
      id: A,
      field: 'PhotoId',
      file_path: file,
    });
    expect(result.isError).toBe(true);
    expect(env.odataClient.putFieldBinary).not.toHaveBeenCalled();
  });
  it('does not claim that a download was saved when disk write fails', async () => {
    const env = setup();
    env.odataClient.getFieldBinary.mockResolvedValue(Buffer.from('file-content'));
    const result = await env.call('bpm_download_file', {
      image_id: A,
      save_path: join(directory, 'missing', 'file.bin'),
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.saved_to).toBeUndefined();
  });
  it('uses the actual OData3 collection and GUID paths for download', async () => {
    const env = setup();
    const request = vi.fn(async (params: { contentKind: string }) => ({
      status: 200,
      headers: {},
      data:
        params.contentKind === 'binary' ? Buffer.from('file-content') : { d: { Id: A, Name: 'example.bin' } },
    }));
    const config = buildConfig('https://crm.example.test', 'tester', 'example-password', {
      odata_version: 3,
      platform: 'netframework',
    });
    env.services.odataClient = new ODataClient(config, { request, setAllowedOrigin: vi.fn() } as never);
    const result = await env.call('bpm_download_file', { image_id: A });
    expect(result.isError).toBeFalsy();
    expect(request.mock.calls[1][0]).toMatchObject({
      url: `https://crm.example.test/0/ServiceModel/EntityDataService.svc/SysImageCollection(guid'${A}')/Data/$value`,
    });
  });
});

describe('HTTP file exchange boundary', () => {
  const auth = { cookies: new Map([['BPMSESSIONID', 'example-session']]) };
  async function remoteSetup() {
    const env = setup();
    const root = join(directory, 'files');
    await mkdir(root);
    env.services.config.file_root = root;
    await writeFile(join(root, 'inside.bin'), 'inside-data');
    return {
      ...env,
      root,
      remoteCall: (name: string, args: Record<string, unknown>) =>
        runWithAuth(auth, () => env.call(name, args)),
    };
  }
  it('reads a relative upload path inside the exchange root', async () => {
    const env = await remoteSetup();
    const result = await env.remoteCall('bpm_upload_file', { file_path: 'inside.bin' });
    expect(result.isError).toBeUndefined();
    expect(env.odataClient.putFieldBinary).toHaveBeenCalledWith(
      'SysImage',
      expect.any(String),
      'Data',
      Buffer.from('inside-data'),
      { fieldType: 'Edm.Binary' }
    );
  });
  it('rejects absolute outside and traversal paths before any remote writes', async () => {
    const env = await remoteSetup();
    for (const path of [file, '../example.bin'])
      expect((await env.remoteCall('bpm_upload_file', { file_path: path })).isError).toBe(true);
    expect(env.odataClient.createRecord).not.toHaveBeenCalled();
  });
  it('rejects an upload symlink escaping the exchange root', async () => {
    const env = await remoteSetup();
    await symlink(file, join(env.root, 'leak.bin'));
    const result = await env.remoteCall('bpm_upload_file', { file_path: 'leak.bin' });
    expect(result.isError).toBe(true);
    expect(env.odataClient.createRecord).not.toHaveBeenCalled();
  });
  it('writes private downloads exclusively without overwriting existing files', async () => {
    const env = await remoteSetup();
    env.odataClient.getFieldBinary.mockResolvedValue(Buffer.from('download-data'));
    expect(
      (await env.remoteCall('bpm_download_file', { image_id: A, save_path: 'inside.bin' })).isError
    ).toBe(true);
    expect(await readFile(join(env.root, 'inside.bin'), 'utf8')).toBe('inside-data');
    expect(
      (await env.remoteCall('bpm_download_file', { image_id: A, save_path: 'new.bin' })).isError
    ).toBeFalsy();
    expect(await readFile(join(env.root, 'new.bin'), 'utf8')).toBe('download-data');
    expect((await stat(join(env.root, 'new.bin'))).mode & 0o777).toBe(0o600);
  });
  it('rejects download parent symlinks and sibling-prefix paths outside the root', async () => {
    const env = await remoteSetup();
    await symlink(directory, join(env.root, 'escape'));
    for (const path of ['escape/output.bin', join(directory, 'files-other', 'output.bin')])
      expect((await env.remoteCall('bpm_download_file', { image_id: A, save_path: path })).isError).toBe(
        true
      );
  });
  it('preserves explicit stdio symlink input compatibility', async () => {
    const env = setup();
    const link = join(directory, 'input-link.bin');
    await symlink(file, link);
    const result = await env.call('bpm_upload_file', { file_path: link });
    expect(result.isError).toBeUndefined();
  });
});

describe('upload target concurrency', () => {
  it('does not overwrite a link changed while bytes were uploaded', async () => {
    const env = setup();
    let targetReads = 0;
    env.odataClient.getRecord.mockImplementation(async (collection, id) =>
      collection === 'Contact'
        ? {
            Id: id,
            Name: 'Target',
            PhotoId: targetReads++ === 0 ? null : 'bbbbbbbb-2222-4222-8222-222222222222',
          }
        : ({ Id: id, Name: 'example.bin' } as never)
    );
    const result = await env.call('bpm_upload_file', {
      file_path: file,
      target_collection: 'Contact',
      target_id: A,
      target_field: 'PhotoId',
    });
    expect(result.isError).toBe(true);
    expect(env.odataClient.putFieldBinary).toHaveBeenCalled();
    expect(env.odataClient.updateRecord).not.toHaveBeenCalled();
    expect(result.structuredContent?.image_id).toEqual(expect.any(String));
  });
  it('does not repeat a link update when the image is already attached', async () => {
    const env = setup();
    env.odataClient.getRecord.mockImplementation(async (_collection, id) => ({
      Id: id,
      Name: 'example.bin',
      MimeType: 'application/octet-stream',
      PhotoId: A,
    }));
    env.odataClient.getFieldBinary.mockResolvedValue(Buffer.from('file-content'));
    const result = await env.call('bpm_upload_file', {
      file_path: file,
      image_id: A,
      target_collection: 'Contact',
      target_id: A,
      target_field: 'PhotoId',
    });
    expect(result.isError).toBeUndefined();
    expect(env.odataClient.updateRecord).not.toHaveBeenCalled();
    expect(env.odataClient.putFieldBinary).not.toHaveBeenCalled();
  });
});

describe('SysImage required-create preflight', () => {
  it('reports additional required fields before creating image or writing bytes', async () => {
    const env = setup();
    env.services.metadataManager.getEntityMetadata = vi.fn(async () => ({
      properties: [
        { name: 'Data', type: 'Edm.Binary' },
        { name: 'Name', type: 'Edm.String', required: true },
        { name: 'CategoryId', type: 'Edm.Guid', required: true, caption: 'Категория' },
      ],
    })) as never;
    const result = await env.call('bpm_upload_file', { file_path: file });
    expect(result.structuredContent?.missing_fields).toEqual([
      { name: 'CategoryId', caption: 'Категория', type: 'Edm.Guid' },
    ]);
    expect(env.odataClient.createRecord).not.toHaveBeenCalled();
    expect(env.odataClient.putFieldBinary).not.toHaveBeenCalled();
  });
});
