import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { startHttpServer } from '../../src/server/http-transport.js';

const servers: Server[] = [];
const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);

afterEach(async () => {
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

function endpoint(server: Server): { host: string; port: number } {
  return { host: '127.0.0.1', port: (server.address() as AddressInfo).port };
}

function post(server: Server, body: unknown): Promise<http.IncomingMessage> {
  const req = http.request({
    ...endpoint(server),
    method: 'POST',
    path: '/mcp',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Content-Length': Buffer.byteLength(JSON.stringify(body)),
      BPMCSRF: 'csrf-test',
      Cookie: 'BPMSESSIONID=test',
    },
  });
  return new Promise((resolve, reject) => {
    req.once('response', resolve);
    req.once('error', reject);
    req.end(JSON.stringify(body));
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for request body admission');
    await new Promise((resolve) => nativeSetTimeout(resolve, 5));
  }
}

describe('HTTP request body deadline', () => {
  it('returns 408 for a stalled body and releases the only admission slot', async () => {
    let expireBody!: () => void;
    const originalSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback, delay, ...args) => {
      if (delay === 30_000) expireBody = () => callback(...args);
      return originalSetTimeout(callback, delay, ...args);
    }) as typeof setTimeout);

    const server = await startHttpServer(
      () => {
        const mcp = new McpServer({ name: 'body-deadline-test', version: '1.0' });
        mcp.registerTool('wait', { inputSchema: {} }, async () => ({
          content: [{ type: 'text', text: 'ready' }],
        }));
        return mcp;
      },
      { port: 0, maxConcurrentRequests: 1, maxQueuedRequests: 0, maxConcurrentPerScope: 1 }
    );
    servers.push(server);

    const stalled = http.request({
      ...endpoint(server),
      method: 'POST',
      path: '/mcp',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Content-Length': '100',
        BPMCSRF: 'csrf-stalled',
        Cookie: 'BPMSESSIONID=stalled',
      },
    });
    const timedOut = new Promise<http.IncomingMessage>((resolve, reject) => {
      stalled.once('response', resolve);
      stalled.once('error', reject);
    });
    stalled.write('{');
    await waitFor(() => typeof expireBody === 'function');
    expireBody();

    const response = await timedOut;
    expect(response.statusCode).toBe(408);
    expect(response.headers.connection).toBe('close');
    response.resume();
    await new Promise<void>((resolve) => response.once('end', resolve));

    const replacement = await post(server, {
      jsonrpc: '2.0',
      id: 'healthy',
      method: 'tools/list',
    });
    expect(replacement.statusCode).toBe(200);
    const replacementBody = await new Promise<string>((resolve, reject) => {
      let text = '';
      replacement.setEncoding('utf8');
      replacement.on('data', (chunk) => (text += chunk));
      replacement.once('end', () => resolve(text));
      replacement.once('error', reject);
    });
    const replacementJson = JSON.parse(replacementBody);
    expect(replacementJson.result.tools.length).toBeGreaterThan(0);
    stalled.destroy();
  });

  it('keeps the body deadline scoped to receipt, not a slow tool call', async () => {
    let bodyTimer: ReturnType<typeof setTimeout> | undefined;
    let bodyTimerCleared = false;
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback, delay, ...args) => {
      const timer = originalSetTimeout(callback, delay, ...args);
      if (delay === 30_000) bodyTimer = timer;
      return timer;
    }) as typeof setTimeout);
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation((timer) => {
      if (timer === bodyTimer) bodyTimerCleared = true;
      return originalClearTimeout(timer);
    });

    let started!: () => void;
    let finish!: () => void;
    const toolStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const server = await startHttpServer(
      () => {
        const mcp = new McpServer({ name: 'body-deadline-slow-tool', version: '1.0' });
        mcp.registerTool('wait', { inputSchema: {} }, async () => {
          started();
          await gate;
          return { content: [{ type: 'text', text: 'done' }] };
        });
        return mcp;
      },
      { port: 0 }
    );
    servers.push(server);

    const responsePromise = post(server, {
      jsonrpc: '2.0',
      id: 'slow',
      method: 'tools/call',
      params: { name: 'wait', arguments: {} },
    });
    await toolStarted;
    expect(bodyTimer).toBeDefined();
    expect(bodyTimerCleared).toBe(true);
    finish();
    const response = await responsePromise;
    expect(response.statusCode).toBe(200);
    const responseBody = await new Promise<string>((resolve, reject) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => (text += chunk));
      response.once('end', () => resolve(text));
      response.once('error', reject);
    });
    const result = JSON.parse(responseBody);
    expect(result.result.content[0].text).toBe('done');
  });
});
