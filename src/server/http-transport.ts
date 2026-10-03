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
 *   Tool schemas and handlers are compiled once per tenant; each request reuses
 *   those definitions with an independent protocol and transport.
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
import { extractAuthFromHeaders, getAuthCacheScope, runWithAuth } from '../auth/request-context.js';
import { BpmApiError } from '../utils/errors.js';
import { RequestAdmission, runWithRequestSignal, waitWithRequestSignal } from './request-runtime.js';

import { SERVER_VERSION } from '../version.js';

const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface HttpServerOptions {
  port: number;
  host?: string;
  /** Exact Host header values accepted through the reverse proxy. */
  allowedHosts?: string[];
  /** Browser origins explicitly allowed to connect. Non-browser clients omit Origin. */
  allowedOrigins?: string[];
  /** Allowlisted tenant ID resolver; raw caller URLs must never be used here. */
  resolveTenant?: (req: http.IncomingMessage) => string;
  /** Require both a CSRF token and a session cookie before any MCP processing. */
  requireAuth?: boolean;
  maxConcurrentRequests?: number;
  maxQueuedRequests?: number;
  /** Per complete forwarded credential context, including tenant. */
  maxConcurrentPerScope?: number;
}

type ServerFactory = (req: http.IncomingMessage) => McpServer | Promise<McpServer>;

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
  createServer: ServerFactory,
  opts: HttpServerOptions
): Promise<http.Server> {
  const host = opts.host ?? '127.0.0.1';
  buildRebindingOptions(host, opts.port, opts);
  const admission = new RequestAdmission(
    opts.maxConcurrentRequests ?? 500,
    opts.maxQueuedRequests ?? 500,
    opts.maxConcurrentPerScope ?? 50
  );
  const httpServer = http.createServer((req, res) => {
    // A socket can fail before admission attaches body listeners, including
    // rejected requests with unread bodies. Keep terminal stream errors handled.
    req.on('error', () => {});
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
    const tenantRoute =
      opts.resolveTenant && /^\/tenants\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\/mcp$/.test(req.url ?? '');
    if (req.url !== '/' && req.url !== '/mcp' && !tenantRoute) {
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

    req.pause();
    void acceptPost(createServer, opts, admission, rebinding, req, res);
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
  createServer: ServerFactory,
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
    server = await createServer(req);
    await server.connect(transport);
    await waitWithRequestSignal(runWithAuth(auth, () => transport.handleRequest(req, res, body)));
  } catch (err) {
    sendHttpError(res, err);
  } finally {
    await transport.close().catch(() => {});
    await server?.close().catch(() => {});
  }
}

async function acceptPost(
  createServer: ServerFactory,
  opts: HttpServerOptions,
  admission: RequestAdmission,
  rebinding: RebindingOptions,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const controller = new AbortController();
  const disconnect = () => controller.abort(new DOMException('Client disconnected', 'AbortError'));
  const close = () => {
    if (!res.writableFinished) disconnect();
  };
  req.once('aborted', disconnect);
  res.once('close', close);
  let release: (() => void) | undefined;
  try {
    const auth = extractAuthFromHeaders(req.headers);
    if (opts.resolveTenant) auth.tenantId = opts.resolveTenant(req);
    if (
      opts.requireAuth &&
      (!auth.csrfToken || !(auth.cookies.get('.ASPXAUTH') || auth.cookies.get('BPMSESSIONID')))
    ) {
      throw new BpmApiError('Передайте BPMCSRF и cookies сессии BPMSoft.', 401);
    }
    const scope = runWithAuth(auth, getAuthCacheScope);
    release = await admission.acquire(scope, controller.signal);
    controller.signal.throwIfAborted();
    const body = await readPostBody(req, controller.signal);
    await runWithRequestSignal(controller.signal, () =>
      runWithAuth(auth, () => handlePost(createServer, rebinding, auth, req, res, body))
    );
  } catch (error) {
    if (!controller.signal.aborted) sendHttpError(res, error);
  } finally {
    req.removeListener('aborted', disconnect);
    res.removeListener('close', close);
    release?.();
  }
}

async function readPostBody(req: http.IncomingMessage, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      req.removeListener('data', data);
      req.removeListener('end', end);
      req.removeListener('error', fail);
      signal.removeEventListener('abort', abort);
    };
    const fail = (error: unknown) => {
      cleanup();
      reject(error);
    };
    const abort = () => fail(signal.reason);
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.pause();
        fail(new BpmApiError('Тело запроса слишком большое.', 413));
      } else chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(raw ? JSON.parse(raw) : undefined);
      } catch {
        reject(new BpmApiError('Parse error', 400));
      }
    };
    req.on('data', data);
    req.once('end', end);
    req.once('error', fail);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    else req.resume();
  });
}

function sendHttpError(res: http.ServerResponse, error: unknown): void {
  if (res.headersSent || res.destroyed) return;
  const status =
    error instanceof BpmApiError && error.httpStatus >= 400 && error.httpStatus <= 499
      ? error.httpStatus
      : 500;
  const messages: Record<number, string> = {
    400: 'Invalid request',
    401: 'Authentication required',
    403: 'Forbidden',
    404: 'Not found',
    413: 'Request too large',
    429: 'Server busy; retry later',
  };
  const message = messages[status] ?? 'Internal server error';
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...(status === 429 ? { 'Retry-After': '1' } : {}),
    // Stop reusing a connection with an unread/oversized request body.
    Connection: 'close',
  });
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: error instanceof BpmApiError && error.message === 'Parse error' ? -32700 : -32000,
        message: error instanceof BpmApiError && error.message === 'Parse error' ? 'Parse error' : message,
      },
    })
  );
}
