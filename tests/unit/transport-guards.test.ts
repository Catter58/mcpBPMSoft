import { describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { startHttpServer } from '../../src/server/http-transport.js';
import { SERVER_VERSION } from '../../src/version.js';

function request(
  port: number,
  options: { path?: string; method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: options.path ?? '/',
        method: options.method ?? 'GET',
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }));
      }
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

describe('HTTP transport admission', () => {
  it('exposes health with the package version and rejects foreign hosts/origins before building tools', async () => {
    const build = vi.fn(() => new McpServer({ name: 'test', version: SERVER_VERSION }));
    const server = await startHttpServer(build, { port: 0, host: '127.0.0.1' });
    const port = (server.address() as AddressInfo).port;
    try {
      const healthy = await request(port, { path: '/healthz' });
      expect(healthy.status).toBe(200);
      expect(JSON.parse(healthy.body)).toEqual({ status: 'ok', version: SERVER_VERSION });
      expect((await request(port, { headers: { Host: 'attacker.test' } })).status).toBe(403);
      expect(
        (await request(port, { method: 'POST', headers: { Origin: 'https://attacker.test' }, body: '{}' }))
          .status
      ).toBe(403);
      const malformed = await request(port, { method: 'POST', body: '{bad' });
      expect(malformed.status).toBe(400);
      expect(JSON.parse(malformed.body).error.code).toBe(-32700);
      expect(build).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('requires an explicit reverse-proxy host allowlist for a public bind', async () => {
    await expect(
      startHttpServer(() => new McpServer({ name: 'test', version: '1' }), { port: 0, host: '0.0.0.0' })
    ).rejects.toThrow('MCP_ALLOWED_HOSTS');
  });
});
