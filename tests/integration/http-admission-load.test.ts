import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { startHttpServer } from '../../src/server/http-transport.js';
import { getRequestAuth, getAuthCacheScope } from '../../src/auth/request-context.js';
import { BpmApiError } from '../../src/utils/errors.js';
import { createToolServer } from '../../src/server/tool-server.js';
import { initializeServices } from '../../src/tools/init-tool.js';
import type { BpmConfig } from '../../src/types/index.js';

const realFetch = globalThis.fetch;
const servers: Server[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
  );
});

function endpoint(server: Server, path = '/mcp'): string {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`;
}

function post(url: string, identity: string, name = 'wait', signal?: AbortSignal): Promise<Response> {
  return realFetch(url, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      BPMCSRF: `csrf-${identity}`,
      Cookie: `BPMSESSIONID=${identity}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: identity,
      method: 'tools/call',
      params: { name, arguments: name === 'bpm_get_records' ? { collection: 'Contact', top: 1 } : {} },
    }),
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for concurrent calls');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('HTTP admission and routing over real loopback', () => {
  it('rejects overflow, removes a disconnected queued request, and keeps health responsive', async () => {
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const factory = () => {
      const mcp = new McpServer({ name: 'admission-test', version: '1.0' });
      mcp.registerTool('wait', { inputSchema: {} }, async () => {
        started++;
        await gate;
        return { content: [{ type: 'text', text: getRequestAuth()?.csrfToken ?? '' }] };
      });
      return mcp;
    };
    const server = await startHttpServer(factory, {
      port: 0,
      maxConcurrentRequests: 1,
      maxQueuedRequests: 1,
      maxConcurrentPerScope: 1,
    });
    servers.push(server);
    const url = endpoint(server);
    const first = post(url, 'first');
    await waitFor(() => started === 1);
    const controller = new AbortController();
    const queued = post(url, 'abandoned', 'wait', controller.signal);
    const failed = expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const overflow = await post(url, 'overflow');
    expect(overflow.status).toBe(429);
    expect(overflow.headers.get('retry-after')).toBe('1');
    expect(await overflow.text()).not.toContain('overflow');
    const health = await realFetch(endpoint(server, '/healthz'));
    expect(health.status).toBe(200);
    await health.arrayBuffer();
    controller.abort();
    await failed;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const replacement = post(url, 'replacement');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(started).toBe(1);
    release();
    const responses = await Promise.all([first, replacement]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    expect(bodies[0].result.content[0].text).toBe('csrf-first');
    expect(bodies[1].result.content[0].text).toBe('csrf-replacement');
    expect(started).toBe(2);
  });

  it('resolves tenant before body/factory and sanitizes routing and auth failures', async () => {
    const factory = vi.fn(() => new McpServer({ name: 'unused', version: '1.0' }));
    const server = await startHttpServer(factory, {
      port: 0,
      requireAuth: true,
      resolveTenant: (req) => {
        if (req.url !== '/tenants/a/mcp') throw new BpmApiError('Secret stand URL https://secret.test', 404);
        return 'a';
      },
    });
    servers.push(server);
    const unknown = await realFetch(endpoint(server, '/tenants/other/mcp'), {
      method: 'POST',
      body: 'broken JSON',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).not.toContain('secret');
    const noAuth = await realFetch(endpoint(server, '/tenants/a/mcp'), {
      method: 'POST',
      body: 'broken JSON',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(noAuth.status).toBe(401);
    await noAuth.arrayBuffer();
    expect(factory).not.toHaveBeenCalled();
  });

  it('releases an active disconnected SDK request even if its handler never settles', async () => {
    let started = false;
    const factory = () => {
      const mcp = new McpServer({ name: 'active-disconnect-test', version: '1.0' });
      mcp.registerTool('wait', { inputSchema: {} }, async () => {
        if (getRequestAuth()?.cookies.get('BPMSESSIONID') === 'abandoned') {
          started = true;
          await new Promise(() => {});
        }
        return { content: [{ type: 'text', text: 'completed' }] };
      });
      return mcp;
    };
    const server = await startHttpServer(factory, {
      port: 0,
      maxConcurrentRequests: 1,
      maxQueuedRequests: 0,
      maxConcurrentPerScope: 1,
    });
    servers.push(server);
    const controller = new AbortController();
    const call = post(endpoint(server), 'abandoned', 'wait', controller.signal);
    const failure = expect(call).rejects.toMatchObject({ name: 'AbortError' });
    await waitFor(() => started);
    controller.abort();
    await failure;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const replacement = await post(endpoint(server), 'replacement');
    expect(replacement.status).toBe(200);
    expect((await replacement.json()).result.content[0].text).toBe('completed');
  });

  it('holds 500 simultaneous authenticated reads across two complete tenant tool factories', async () => {
    const config: BpmConfig = {
      bpmsoft_url: 'https://bpm.test',
      journal_root: '/private/tmp/mcp-load-test-unused-journal',
      odata_version: 4,
      platform: 'net8',
      page_size: 100,
      max_batch_size: 100,
      lookup_cache_ttl: 300,
      request_timeout: 30000,
      max_file_size: 1024 * 1024,
    };
    const servicesByTenant = new Map(
      ['a', 'b'].map((tenant) => {
        const services = initializeServices(
          { ...config, tenant_id: tenant, bpmsoft_url: `https://bpm.test/stand-${tenant}` },
          false
        );
        vi.spyOn(services.metadataManager, 'resolveCollectionReference').mockResolvedValue({
          name: 'Contact',
        });
        vi.spyOn(services.metadataManager, 'getEntityMetadata').mockResolvedValue({
          name: 'Contact',
          collectionName: 'Contact',
          cachedAt: Date.now(),
          lookupFields: [],
          properties: [{ name: 'Id', type: 'Edm.Guid', nullable: false, isLookup: false }],
        });
        return [tenant, services] as const;
      })
    );
    let started = 0;
    let peak = 0;
    let active = 0;
    const credentials = new Set<string>();
    const rawCredentials = new Set<string>();
    const scopes = new Set<string>();
    const tenantRequests = { a: 0, b: 0 };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!url.startsWith('https://bpm.test/')) return realFetch(input, init);
        const urlTenant = /^https:\/\/bpm\.test\/stand-([ab])\//.exec(url)?.[1] as 'a' | 'b' | undefined;
        expect(urlTenant).toBeDefined();
        const headers = new Headers(init?.headers);
        const cookie = headers.get('cookie')!;
        credentials.add(`${urlTenant}:${cookie}`);
        rawCredentials.add(cookie);
        scopes.add(getAuthCacheScope());
        expect(getRequestAuth()?.tenantId).toBe(urlTenant);
        const identity = /BPMSESSIONID=([^;]+)/.exec(cookie)![1];
        expect(headers.get('bpmcsrf')).toBe(`csrf-${identity}`);
        tenantRequests[urlTenant!]++;
        started++;
        active++;
        peak = Math.max(peak, active);
        await gate;
        active--;
        return Response.json({ value: [{ Id: `${urlTenant}:${identity}` }] });
      })
    );
    const resolveTenant = (url: string | undefined): 'a' | 'b' => {
      if (url === '/tenants/a/mcp') return 'a';
      if (url === '/tenants/b/mcp') return 'b';
      throw new BpmApiError('Unknown tenant', 404);
    };
    const server = await startHttpServer(
      (req) => createToolServer(servicesByTenant.get(resolveTenant(req.url))!),
      {
        port: 0,
        requireAuth: true,
        resolveTenant: (req) => resolveTenant(req.url),
      }
    );
    servers.push(server);
    for (const tenant of ['a', 'b']) {
      const listed = await realFetch(endpoint(server, `/tenants/${tenant}/mcp`), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          BPMCSRF: 'csrf-list',
          Cookie: 'BPMSESSIONID=list',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'list', method: 'tools/list' }),
      });
      expect(listed.status).toBe(200);
      const tools = (await listed.json()).result.tools as Array<{ name: string }>;
      expect(tools).toHaveLength(41);
      expect(tools.some((tool) => tool.name === 'bpm_get_operation')).toBe(true);
      expect(tools.some((tool) => tool.name === 'bpm_init')).toBe(false);
    }
    expect(started).toBe(0);
    const startedAt = performance.now();
    const rssBefore = process.memoryUsage().rss;
    const calls: Promise<Response>[] = [];
    let waitError: unknown;
    try {
      // Establish connections in small batches so host TCP listen-backlog limits
      // do not masquerade as an application concurrency limit. Every accepted
      // upstream call stays gated until all 500 are active simultaneously.
      for (let index = 0; index < 500; index++) {
        const tenant = index % 2 ? 'b' : 'a';
        // Identical cookies/tokens on different stands must still have distinct scopes.
        const call = post(
          endpoint(server, `/tenants/${tenant}/mcp`),
          `user-${Math.floor(index / 2)}`,
          'bpm_get_records'
        );
        void call.catch(() => {});
        calls.push(call);
        if (index % 25 === 24) await waitFor(() => started >= index + 1);
      }
      await waitFor(() => started === 500);
      expect(peak).toBe(500);
      expect(credentials.size).toBe(500);
      expect(rawCredentials.size).toBe(250);
      expect(scopes.size).toBe(500);
      expect(tenantRequests).toEqual({ a: 250, b: 250 });
      const health = await realFetch(endpoint(server, '/healthz'));
      expect(health.status).toBe(200);
      await health.arrayBuffer();
    } catch (error) {
      waitError = error;
    } finally {
      release();
    }
    const outcomes = await Promise.allSettled(calls);
    const responses = outcomes
      .filter((outcome): outcome is PromiseFulfilledResult<Response> => outcome.status === 'fulfilled')
      .map((outcome) => outcome.value);
    const results = await Promise.all(responses.map((response) => response.json()));
    if (waitError) {
      const rejected = outcomes.find((outcome) => outcome.status === 'rejected') as
        | PromiseRejectedResult
        | undefined;
      throw new Error(
        `Concurrency wait failed: started=${started}, responses=${responses.length}, rejected=${JSON.stringify(rejected?.reason?.cause)}, first=${JSON.stringify(results[0])}`,
        { cause: waitError }
      );
    }
    expect(responses).toHaveLength(500);
    expect(responses.every((response) => response.status === 200)).toBe(true);
    results.forEach((result, index) => {
      expect(result.result.isError).toBeFalsy();
      const tenant = index % 2 ? 'b' : 'a';
      expect(result.result.structuredContent.records).toEqual([
        { Id: `${tenant}:user-${Math.floor(index / 2)}` },
      ]);
    });
    console.info(
      JSON.stringify({
        benchmark: '500-concurrent-production-MCP-reads',
        requests: results.length,
        peakConcurrentUpstream: peak,
        elapsedMs: Math.round(performance.now() - startedAt),
        rssIncreaseMiB: Math.round((process.memoryUsage().rss - rssBefore) / 1024 / 1024),
        distinctCredentialScopes: scopes.size,
        tenants: 2,
        toolsPerTenant: 41,
        requestsPerTenant: tenantRequests,
      })
    );
  }, 45000);
});
