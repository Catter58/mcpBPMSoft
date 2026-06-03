import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { AddressInfo } from 'node:net';

import { startHttpServer } from '../../src/server/http-transport.js';
import { initializeServices } from '../../src/tools/init-tool.js';
import { registerReadTools } from '../../src/tools/read-tools.js';
import type { BpmConfig } from '../../src/types/index.js';

const ORIGIN = 'https://bpm.test';

function cfg(): BpmConfig {
  return {
    bpmsoft_url: ORIGIN,
    odata_version: 4,
    platform: 'net8',
    page_size: 100,
    max_batch_size: 100,
    lookup_cache_ttl: 300,
    request_timeout: 5000,
    max_file_size: 10 * 1024 * 1024,
  };
}

// Allow localhost (MCP transport) to bypass MSW; intercept only the BPMSoft origin.
const mock = setupServer();
beforeAll(() => mock.listen({ onUnhandledRequest: 'bypass' }));
afterAll(() => mock.close());
afterEach(() => mock.resetHandlers());

describe('HTTP transport forwards per-request auth', () => {
  it('forwards caller BPMCSRF to the outgoing OData request', async () => {
    let capturedCsrf: string | null = null;
    mock.use(
      http.get(`${ORIGIN}/odata/Contact`, ({ request }) => {
        capturedCsrf = request.headers.get('bpmcsrf');
        return HttpResponse.json({ value: [{ Id: '1' }] });
      })
    );

    const services = initializeServices(cfg(), false);
    const makeServer = () => {
      const mcp = new McpServer({ name: 'test', version: '0.0.0' });
      registerReadTools(mcp, services);
      return mcp;
    };

    const httpServer = await startHttpServer(makeServer, { port: 0, host: '127.0.0.1' });
    const { port } = httpServer.address() as AddressInfo;

    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/`),
      {
        requestInit: { headers: { BPMCSRF: 'caller-csrf', Cookie: 'CsrfToken=t; BPMSESSIONID=s' } },
        // Drain-and-detach the loopback response body before handing it to the
        // MCP client. MSW's node fetch interceptor (2.x) does not resolve
        // `response.body.cancel()` on undrained loopback responses (notably the
        // empty-body 202 for notifications/initialized), which would hang the
        // client. Fully reading the body here sidesteps that interceptor quirk;
        // the tool's outgoing request to ORIGIN is still intercepted normally.
        fetch: async (input, init) => {
          const resp = await fetch(input as RequestInfo, init);
          const buf = await resp.arrayBuffer();
          return new Response(buf.byteLength ? buf : null, {
            status: resp.status,
            statusText: resp.statusText,
            headers: resp.headers,
          });
        },
      }
    );
    await client.connect(transport);

    const res = await client.callTool({
      name: 'bpm_get_records',
      arguments: { collection: 'Contact', top: 1 },
    });

    expect(res.isError).toBeFalsy();
    expect(capturedCsrf).toBe('caller-csrf');

    await client.close();
    httpServer.close();
  });
});
