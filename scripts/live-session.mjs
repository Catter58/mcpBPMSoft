import { createInterface } from 'node:readline';
import { writeFile } from 'node:fs/promises';

// Credentials arrive on stdin and stay in this process only.
const input = createInterface({ input: process.stdin, terminal: false });
let base;
let cookies = new Map();
let csrf;
let toolClient;
let toolServices;
let runWithAuth;
const results = new Map();

function toolArguments(command) {
  const args = { ...(command.arguments ?? {}) };
  for (const [key, reference] of Object.entries(command.from ?? {})) {
    const value = results.get(reference.result)?.structuredContent?.[reference.field];
    if (value === undefined)
      throw new Error(`Missing remembered result: ${reference.result}.${reference.field}`);
    args[key] = value;
  }
  return args;
}

async function callTool(name, args) {
  if (!toolClient) {
    const [
      { Client },
      { InMemoryTransport },
      { createToolServer },
      { initializeServices },
      { buildConfig },
      context,
    ] = await Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'),
      import('@modelcontextprotocol/sdk/inMemory.js'),
      import('../build/server/tool-server.js'),
      import('../build/tools/init-tool.js'),
      import('../build/config.js'),
      import('../build/auth/request-context.js'),
    ]);
    runWithAuth = context.runWithAuth;
    toolServices = initializeServices(
      buildConfig(base, undefined, undefined, { platform: 'net8', odata_version: 4 }),
      false
    );
    const server = createToolServer(toolServices);
    toolClient = new Client({ name: 'live-verification', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), toolClient.connect(clientTransport)]);
  }
  return runWithAuth({ cookies, csrfToken: csrf }, () => toolClient.callTool({ name, arguments: args }));
}

function collectCookies(response) {
  for (const line of response.headers.getSetCookie()) {
    const item = line.split(';')[0];
    const separator = item.indexOf('=');
    if (separator > 0) cookies.set(item.slice(0, separator), item.slice(separator + 1));
  }
  csrf = cookies.get('BPMCSRF') ?? cookies.get('CsrfToken') ?? csrf;
}

async function request(path, options = {}) {
  const url = new URL(path, base);
  if (url.origin !== new URL(base).origin) throw new Error('Target origin mismatch');
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers: {
      Accept: options.accept ?? 'application/json',
      'Content-Type': 'application/json',
      Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '),
      ...(csrf ? { BPMCSRF: csrf } : {}),
      ForceUseSession: 'true',
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: 'manual',
    signal: AbortSignal.timeout(30000),
  });
  collectCookies(response);
  const text = await response.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return {
    status: response.status,
    location: response.headers.get('location'),
    etag: response.headers.get('etag'),
    data,
  };
}

console.log(JSON.stringify({ ready: true }));
for await (const line of input) {
  try {
    const command = JSON.parse(line);
    if (command.type === 'login') {
      base = command.url;
      cookies = new Map();
      const result = await request('/ServiceModel/AuthService.svc/Login', {
        method: 'POST',
        body: { UserName: command.username, UserPassword: command.password },
      });
      console.log(
        JSON.stringify({
          login_status: result.status,
          code: result.data?.Code,
          csrf_available: Boolean(csrf),
          cookie_names: [...cookies.keys()],
        })
      );
    } else if (command.type === 'request') {
      const result = await request(command.path, command);
      if (command.save) {
        await writeFile(
          command.save,
          typeof result.data === 'string' ? result.data : JSON.stringify(result.data)
        );
        console.log(
          JSON.stringify({
            status: result.status,
            saved: true,
            bytes: Buffer.byteLength(
              typeof result.data === 'string' ? result.data : JSON.stringify(result.data)
            ),
            etag: result.etag,
          })
        );
      } else {
        const output = JSON.stringify(result);
        console.log(
          output.length > (command.output_limit ?? 10000)
            ? output.slice(0, command.output_limit ?? 10000) + '…'
            : output
        );
      }
    } else if (command.type === 'mcp') {
      const result = await callTool(command.name, toolArguments(command));
      if (command.remember) results.set(command.remember, result);
      const output = JSON.stringify(result);
      console.log(
        output.length > (command.output_limit ?? 16000)
          ? output.slice(0, command.output_limit ?? 16000) + '…'
          : output
      );
    } else if (command.type === 'exit') {
      await toolClient?.close();
      cookies.clear();
      csrf = undefined;
      base = undefined;
      results.clear();
      input.close();
      break;
    } else {
      throw new Error('Unknown command');
    }
  } catch (error) {
    console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
}
