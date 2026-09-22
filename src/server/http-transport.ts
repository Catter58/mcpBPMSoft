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
 *   in MCP_ALLOWED_ORIGINS (if set). Exception: bound to a wildcard address
 *   (0.0.0.0 / ::, e.g. Docker) with no MCP_ALLOWED_HOSTS — the public host name is
 *   unknown, so the Host check is skipped with a startup warning instead of locking
 *   everyone out. Set MCP_ALLOWED_HOSTS in such deployments.
 */

import http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { extractAuthFromHeaders, runWithAuth } from '../auth/request-context.js';

const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface HttpServerOptions {
  port: number;
  host?: string;
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
export function buildRebindingOptions(host: string, port: number): RebindingOptions {
  const extraHosts = splitEnv('MCP_ALLOWED_HOSTS');
  const origins = splitEnv('MCP_ALLOWED_ORIGINS');
  const wildcard = host === '0.0.0.0' || host === '::';
  let allowedHosts: string[] | undefined;
  if (wildcard && extraHosts.length === 0) {
    console.error(
      `[http-transport] WARNING: bound to ${host} without MCP_ALLOWED_HOSTS — Host header check is off. ` +
        'Set MCP_ALLOWED_HOSTS=<public-host:port>[,...] to enable DNS-rebinding protection.'
    );
  } else {
    const hostPort = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
    allowedHosts = [...new Set([`127.0.0.1:${port}`, `localhost:${port}`, hostPort, ...extraHosts])];
  }
  return { allowedHosts, allowedOrigins: origins.length ? origins : undefined };
}

export async function startHttpServer(
  createServer: () => McpServer,
  opts: HttpServerOptions
): Promise<http.Server> {
  const host = opts.host ?? '127.0.0.1';
  let rebinding: RebindingOptions = {};
  const httpServer = http.createServer((req, res) => {
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
        body = undefined;
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

  await new Promise<void>((resolve) => {
    httpServer.listen(opts.port, host, () => resolve());
  });

  const addr = httpServer.address();
  const shownPort = typeof addr === 'object' && addr ? addr.port : opts.port;
  rebinding = buildRebindingOptions(host, shownPort);
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
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    enableDnsRebindingProtection: true,
    ...rebinding,
  });
  try {
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
    await server.close().catch(() => {});
  }
}
