/**
 * Unit tests for ProcessEngineClient (GR-7).
 *
 * Stubs HttpClient.request via MockHttpClient to assert the URL/contentKind
 * shape and verify the XML envelope unwrapping logic.
 */

import { describe, it, expect } from 'vitest';
import { ProcessEngineClient } from '../../src/process/process-engine-client.js';
import { BpmApiError } from '../../src/utils/errors.js';
import { MockHttpClient } from '../setup/mock-http-client.js';
import type { BpmConfig } from '../../src/types/index.js';

function makeCfg(overrides: Partial<BpmConfig> = {}): BpmConfig {
  return {
    bpmsoft_url: 'https://bpm.test',
    username: 'u',
    password: 'p',
    odata_version: 4,
    platform: 'net8',
    page_size: 100,
    max_batch_size: 100,
    lookup_cache_ttl: 300,
    request_timeout: 30000,
    max_file_size: 10 * 1024 * 1024,
    ...overrides,
  };
}

function envelope(payload: string): string {
  return `<string xmlns="http://schemas.microsoft.com/2003/10/Serialization/">${payload}</string>`;
}

describe('ProcessEngineClient.execute', () => {
  it('builds the correct URL with parameters and ResultParameterName', async () => {
    const http = new MockHttpClient();
    http.setResponses([
      () => ({ status: 200, data: envelope('42') }),
    ]);
    const client = new ProcessEngineClient(makeCfg(), http as unknown as never);

    await client.execute(
      'UsrCalculateScore',
      { LeadId: '11111111-2222-3333-4444-555555555555', Boost: 5, Active: true },
      { resultParameterName: 'Score' }
    );

    expect(http.requests).toHaveLength(1);
    const req = http.requests[0];
    expect(req.method).toBe('GET');
    expect(req.contentKind).toBe('metadata');
    expect(req.responseType).toBe('text');

    const url = new URL(req.url);
    expect(url.origin + url.pathname).toBe(
      'https://bpm.test/ServiceModel/ProcessEngineService.svc/UsrCalculateScore/Execute'
    );
    expect(url.searchParams.get('LeadId')).toBe('11111111-2222-3333-4444-555555555555');
    expect(url.searchParams.get('Boost')).toBe('5');
    expect(url.searchParams.get('Active')).toBe('true');
    expect(url.searchParams.get('ResultParameterName')).toBe('Score');
  });

  it('parses an XML envelope with a numeric payload into a number', async () => {
    const http = new MockHttpClient();
    http.setResponses([() => ({ status: 200, data: envelope('42') })]);
    const client = new ProcessEngineClient(makeCfg(), http as unknown as never);

    const outcome = await client.execute('UsrEcho', {}, { resultParameterName: 'Out' });

    expect(outcome.status).toBe(200);
    expect(outcome.result).toBe(42);
  });

  it('parses an XML envelope with a JSON-encoded array payload', async () => {
    const http = new MockHttpClient();
    const inner = '[{"Id":"abc","Name":"Foo"},{"Id":"def","Name":"Bar"}]';
    http.setResponses([() => ({ status: 200, data: envelope(inner) })]);
    const client = new ProcessEngineClient(makeCfg(), http as unknown as never);

    const outcome = await client.execute('UsrListItems', {}, { resultParameterName: 'Items' });

    expect(Array.isArray(outcome.result)).toBe(true);
    expect(outcome.result).toEqual([
      { Id: 'abc', Name: 'Foo' },
      { Id: 'def', Name: 'Bar' },
    ]);
  });

  it('returns empty raw on 204 / empty body without throwing', async () => {
    const http = new MockHttpClient();
    http.setResponses([() => ({ status: 204, data: '' })]);
    const client = new ProcessEngineClient(makeCfg(), http as unknown as never);

    const outcome = await client.execute('UsrFireAndForget');

    expect(outcome.status).toBe(204);
    expect(outcome.raw).toBe('');
    expect(outcome.result).toBeUndefined();
  });

  it('rejects unsafe process names with BpmApiError', async () => {
    const http = new MockHttpClient();
    const client = new ProcessEngineClient(makeCfg(), http as unknown as never);

    await expect(client.execute('Bad Name; DROP', {})).rejects.toBeInstanceOf(BpmApiError);
    expect(http.requests).toHaveLength(0);
  });

  it('rejects unsafe parameter keys with BpmApiError', async () => {
    const http = new MockHttpClient();
    const client = new ProcessEngineClient(makeCfg(), http as unknown as never);

    await expect(
      client.execute('UsrEcho', { 'bad key': 'x' })
    ).rejects.toBeInstanceOf(BpmApiError);
    expect(http.requests).toHaveLength(0);
  });
});

describe('ProcessEngineClient.execProcElByUId', () => {
  it('builds the correct URL with the GUID', async () => {
    const http = new MockHttpClient();
    http.setResponses([() => ({ status: 200, data: '' })]);
    const client = new ProcessEngineClient(makeCfg(), http as unknown as never);

    const uid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const outcome = await client.execProcElByUId(uid);

    expect(outcome.status).toBe(200);
    expect(http.requests).toHaveLength(1);
    expect(http.requests[0].url).toBe(
      `https://bpm.test/ServiceModel/ProcessEngineService.svc/ExecProcElByUId?ProcessElementUID=${uid}`
    );
  });

  it('rejects invalid GUIDs with BpmApiError', async () => {
    const http = new MockHttpClient();
    const client = new ProcessEngineClient(makeCfg(), http as unknown as never);

    await expect(client.execProcElByUId('not-a-guid')).rejects.toBeInstanceOf(BpmApiError);
    expect(http.requests).toHaveLength(0);
  });
});
