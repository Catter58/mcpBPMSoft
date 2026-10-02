import { readFileSync } from 'node:fs';

/** Package version is shared by npm and the MCP initialization response. */
export const SERVER_VERSION: string = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
).version;
