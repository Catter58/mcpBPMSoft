/**
 * Streamable HTTP transport bootstrap.
 *
 * Hosts the MCP server over HTTP and binds each incoming request's auth
 * (BPMCSRF + cookies) to an AsyncLocalStorage context, so tools forward the
 * caller's credentials to BPMSoft per-request (mcp-proxy-server pattern).
 *
 * Stateless: no server-side session state is retained.
 *
 * Transport mode chosen: STATELESS, FRESH-SERVER-AND-TRANSPORT-PER-REQUEST,
 * fully concurrent (no serialization).
 *
 * Why per-request server + transport:
 *   SDK 1.29's StreamableHTTPServerTransport in stateless mode
 *   (`sessionIdGenerator: undefined`) explicitly refuses to be reused across
 *   requests, and a single McpServer (Protocol) allows only one connected
 *   transport at a time. Rather than serialize all requests against one shared
 *   server (which would funnel every slow OData round-trip through a single
 *   lane), we build a fresh McpServer + fresh stateless transport PER REQUEST.
 *   Each request runs in its own server/transport with its own
 *   AsyncLocalStorage auth context, so callers' BPMCSRF/cookies never cross
 *   between requests and slow OData round-trips overlap instead of serializing.
 *   Re-registering the ~36 tools per request is cheap in-memory work
 *   (single-digit ms) that overlaps the network I/O it enables.
 *
 * Why `enableJsonResponse: true`:
 *   It returns a single buffered JSON response per POST instead of an
 *   open-ended SSE stream. With JSON responses, `handleRequest` resolves after
 *   the response has been sent, so closing the transport/server in `finally`
 *   afterwards is safe. The SDK client consumes either mode.
 *
 * Why GET/DELETE -> 405:
 *   After initialize, the SDK client opens a standalone GET SSE stream for
 *   server-initiated messages. In stateless JSON-response mode we have no
 *   server-initiated traffic, so we reject GET/DELETE with 405 (same as the
 *   SDK's stateless example); the client treats the optional GET stream's
 *   failure as non-fatal and proceeds with POSTs.
 *
 * The ALS wrap (`runWithAuth`) surrounds `transport.handleRequest`, so the
 * caller's auth is in-context when the tool callback runs.
 *
 * DNS-rebinding protection (SDK `enableDnsRebindingProtection`):
 *   Host must be one of `127.0.0.1:<port>`, `localhost:<port>`, `<bound host>:<port>`
 *   plus MCP_ALLOWED_HOSTS (comma list). Origin, when the browser sends one, must be
 *   in MCP_ALLOWED_ORIGINS (or the allowed Host origins by default). Public binds
 *   require an explicit MCP_ALLOWED_HOSTS list.
 */

import http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { extractAuthFromHeaders, runWithAuth } from '../auth/request-context.js';

import { SERVER_VERSION } from '../version.js';

const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface HttpServerOptions {
  port: number;
  host?: string;
  /** Exact Host header values accepted through the reverse proxy. */
  allowedHosts?: string[];
  /** Browser origins explicitly allowed to connect. Non-browser clients omit Origin. */
  allowedOrigins?: string[];
}

/**
 * Host the MCP server over Streamable HTTP.
 *
 * A fresh McpServer + stateless transport is built PER REQUEST (the SDK's
 * Protocol allows only one connected transport at a time, and a stateless
 * transport cannot be reused). This keeps requests fully concurrent — each
 * runs in its own server/transport with its own AsyncLocalStorage auth
 * context, so callers' BPMCSRF/cookies never cross between requests and
 * slow OData round-trips overlap instead of serializing.
 *
 * `createServer` must return a fully-registered McpServer (tools/prompts/resources).
 */
const splitEnv = (name: string): string[] =>
  (process.env[name] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

type RebindingOptions = { allowedHosts?: string[]; allowedOrigins?: string[] };

/** Allowed Host/Origin lists for the SDK's DNS-rebinding check (exported for tests). */
export function buildRebindingOptions(
  host: string,
  port: number,
  options: Pick<HttpServerOptions, 'allowedHosts' | 'allowedOrigins'> = {}
): RebindingOptions {
  const configuredHosts = options.allowedHosts ?? splitEnv('MCP_ALLOWED_HOSTS');
  const origins = options.allowedOrigins ?? splitEnv('MCP_ALLOWED_ORIGINS');
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !configuredHosts.length) {
    throw new Error(
      'Для публичного интерфейса задайте MCP_ALLOWED_HOSTS — разрешённые Host заголовки reverse proxy.'
    );
  }
  const allowedHosts = configuredHosts.length
    ? [...new Set(configuredHosts)]
    : [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  return {
    allowedHosts,
    allowedOrigins: origins.length
      ? [...new Set(origins)]
      : allowedHosts.flatMap((item) => [`http://${item}`, `https://${item}`]),
  };
}

export async function startHttpServer(
  createServer: () => McpServer,
  opts: HttpServerOptions
): Promise<http.Server> {
  const host = opts.host ?? '127.0.0.1';
  buildRebindingOptions(host, opts.port, opts);
  const httpServer = http.createServer((req, res) => {
    const address = httpServer.address();
    const port = typeof address === 'object' && address ? address.port : opts.port;
    const rebinding = buildRebindingOptions(host, port, opts);
    const allowedHosts = rebinding.allowedHosts!;
    if (!req.headers.host || !allowedHosts.includes(req.headers.host)) {
      res.writeHead(403);
      res.end();
      return;
    }
    const origin = req.headers.origin;
    const allowedOrigins = rebinding.allowedOrigins!;
    if (origin && !allowedOrigins.includes(origin)) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ status: 'ok', version: SERVER_VERSION }));
      return;
    }
    if (req.url !== '/' && req.url !== '/mcp') {
      res.writeHead(404);
      res.end();
      return;
    }
    // GET/DELETE (standalone SSE / session teardown) unsupported in stateless JSON mode.
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('Allow', 'POST');
      res.end();
      return;
    }

    const auth = extractAuthFromHeaders(req.headers);

    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        if (!res.headersSent) {
          res.statusCode = 413;
          res.end();
        }
        req.destroy();
        return;
      }
      chunks.push(c);
    });

    req.on('end', () => {
      if (aborted) return;
      let body: unknown;
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
        );
        return;
      }
      void handlePost(createServer, rebinding, auth, req, res, body);
    });

    req.on('error', (err) => {
      console.error('[http-transport] request error:', err);
      if (!res.headersSent) {
        res.statusCode = 400;
        res.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(opts.port, host, () => {
      httpServer.removeListener('error', reject);
      resolve();
    });
  });

  const addr = httpServer.address();
  const shownPort = typeof addr === 'object' && addr ? addr.port : opts.port;
  console.error(`[http-transport] listening on ${host}:${shownPort}`);

  return httpServer;
}

async function handlePost(
  createServer: () => McpServer,
  rebinding: RebindingOptions,
  auth: ReturnType<typeof extractAuthFromHeaders>,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: unknown
): Promise<void> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    enableDnsRebindingProtection: true,
    ...rebinding,
  });
  let server: McpServer | undefined;
  try {
    server = createServer();
    await server.connect(transport);
    await runWithAuth(auth, () => transport.handleRequest(req, res, body));
  } catch (err) {
    console.error('[http-transport] handleRequest error:', err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end();
    }
  } finally {
    await transport.close().catch(() => {});
    await server?.close().catch(() => {});
  }
}
