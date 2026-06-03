/**
 * Streamable HTTP transport bootstrap.
 *
 * Hosts the MCP server over HTTP and binds each incoming request's auth
 * (BPMCSRF + cookies) to an AsyncLocalStorage context, so tools forward the
 * caller's credentials to BPMSoft per-request (mcp-proxy-server pattern).
 *
 * Stateless: no server-side session state is retained.
 *
 * Transport mode chosen: STATELESS, FRESH-TRANSPORT-PER-REQUEST,
 * with SERIALIZED connect/close against the shared McpServer.
 *
 * Why per-request transport (not a single persistent one):
 *   SDK 1.29's StreamableHTTPServerTransport in stateless mode
 *   (`sessionIdGenerator: undefined`) explicitly refuses to be reused —
 *   the second `handleRequest` throws "Stateless transport cannot be reused
 *   across requests. Create a new transport per request." (see
 *   webStandardStreamableHttp.js). Because an MCP client performs several
 *   POSTs over one logical connection (initialize, then
 *   notifications/initialized, then tool calls), a single persistent transport
 *   would fail after the first request. We therefore create a fresh transport
 *   per HTTP request and (re)connect the shared McpServer to it.
 *
 * Why serialize:
 *   A single McpServer (Protocol) allows only one connected transport at a
 *   time — `connect()` throws "Already connected to a transport" otherwise.
 *   The client fires `notifications/initialized` immediately after the
 *   initialize response, so the next POST can arrive before the previous
 *   transport has detached. We chain requests on a promise and explicitly
 *   `close()` each transport (detaching it from the server) before connecting
 *   the next, so connect/close stays strictly sequential.
 *
 * Why `enableJsonResponse: true`:
 *   It returns a single buffered JSON response per POST instead of an
 *   open-ended SSE stream, which makes the per-request close deterministic and
 *   avoids holding the Node response open. The SDK client consumes either mode.
 *
 * Why GET/DELETE -> 405:
 *   After initialize, the SDK client opens a standalone GET SSE stream for
 *   server-initiated messages. That stream is long-lived and would block our
 *   serialized POST chain forever. In stateless JSON-response mode we have no
 *   server-initiated traffic, so we reject GET/DELETE with 405 (same as the
 *   SDK's stateless example); the client treats the optional GET stream's
 *   failure as non-fatal and proceeds with POSTs.
 *
 * The ALS wrap (`runWithAuth`) surrounds `transport.handleRequest`, so the
 * caller's auth is in-context when the tool callback runs inside the promise
 * chain started within that scope.
 */

import http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { extractAuthFromHeaders, runWithAuth } from '../auth/request-context.js';

export interface HttpServerOptions {
  port: number;
  host?: string;
}

export async function startHttpServer(
  server: McpServer,
  opts: HttpServerOptions
): Promise<http.Server> {
  // Serializes connect/handle/close cycles against the single shared McpServer
  // so only one transport is ever connected at a time (see file header).
  let chain: Promise<void> = Promise.resolve();

  const httpServer = http.createServer((req, res) => {
    // Only POST carries JSON-RPC. Reject the optional standalone GET SSE stream
    // (and DELETE) with 405 so they don't block the serialized POST chain.
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('Allow', 'POST');
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Method not allowed.' },
          id: null,
        })
      );
      return;
    }

    const auth = extractAuthFromHeaders(req.headers);

    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let body: unknown;
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = undefined;
      }

      // Wait for any in-flight request to fully detach before connecting.
      chain = chain.then(async () => {
        // Fresh stateless transport per request (see file header for rationale).
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });

        const finished = new Promise<void>((resolve) => {
          res.on('close', () => resolve());
          res.on('finish', () => resolve());
        });

        try {
          await server.connect(transport);
          await runWithAuth(auth, () => transport.handleRequest(req, res, body));
          // Ensure the response is flushed before detaching the transport.
          await finished;
        } catch (err) {
          console.error('[http-transport] handleRequest error:', err);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.end();
          }
        } finally {
          // Detach this transport from the shared server (resets server._transport)
          // so the next queued request can connect cleanly.
          await transport.close().catch(() => {
            /* already closing */
          });
        }
      });
    });

    req.on('error', (err) => {
      console.error('[http-transport] request error:', err);
      if (!res.headersSent) {
        res.statusCode = 400;
        res.end();
      }
    });
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(opts.port, opts.host ?? '0.0.0.0', () => resolve());
  });

  const addr = httpServer.address();
  const shownPort = typeof addr === 'object' && addr ? addr.port : opts.port;
  console.error(`[http-transport] listening on ${opts.host ?? '0.0.0.0'}:${shownPort}`);

  return httpServer;
}
