import { chmod, lstat, open, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export const STAGES = new Set(['schema', 'exercise', 'read-checks', 'fault-checks', 'cleanup', 'inspect']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATE_KEYS = new Set([
  'version',
  'marker',
  'account_names',
  'activity_title',
  'planned_ids',
  'absent_probe_id',
  'idempotency_key',
  'exercise_started',
  'exercise_completed',
  'fault_started',
  'fault_completed',
  'cleanup_started',
  'cleanup_completed',
  'account_ids',
  'activity_id',
  'batch_args',
  'batch_confirmation',
  'batch_update_started',
  'fault_expected',
  'expected_churn',
  'activity_expected',
  'activity_timezone',
  'planned_records',
  'schema',
]);
const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const RECORD_COLLECTIONS = new Set(['Account', 'Activity']);
const READONLY_SERVICE_PATHS = new Set([
  '/ServiceModel/EntitySchemaDesignerService.svc/GetSchema',
  '/0/DataService/json/SyncReply/SelectQuery',
]);

export function parseOptions(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (!item.startsWith('--')) throw new Error('Options must start with --.');
    const key = item.slice(2);
    if (STAGES.has(key)) {
      if (out.stage) throw new Error('Choose exactly one stage.');
      out.stage = key;
    } else if (['auth', 'state', 'marker'].includes(key)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}.`);
      out[key] = value;
    } else throw new Error(`Unsupported option: ${item}`);
  }
  if (!out.stage) throw new Error('Choose one stage.');
  if (out.stage !== 'schema' && (!out.auth || !out.state || !out.marker))
    throw new Error('This stage requires --auth, --state, and --marker.');
  if (out.stage === 'schema' && !out.auth) throw new Error('Schema discovery requires --auth.');
  if (out.marker && !/^[A-Za-z0-9_-]{8,64}$/.test(out.marker))
    throw new Error('Marker must be 8–64 safe ASCII characters.');
  return out;
}

export function initialState(marker) {
  if (typeof marker !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(marker))
    throw new Error('Marker must be 8–64 safe ASCII characters.');
  const plannedIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  return {
    version: 1,
    marker,
    account_names: ['A', 'B', 'C'].map((suffix) => `MCP UX ${marker} ${suffix}`),
    activity_title: `MCP UX ${marker} Activity`,
    planned_ids: plannedIds,
    account_ids: plannedIds.slice(0, 3),
    activity_id: plannedIds[3],
    absent_probe_id: randomUUID(),
    idempotency_key: randomUUID(),
    exercise_started: false,
    exercise_completed: false,
    fault_started: false,
    fault_completed: false,
    cleanup_started: false,
    cleanup_completed: false,
  };
}

export async function readOwnerFile(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    assertOwnerOnlyRegular(stat);
    return await handle.readFile('utf8');
  } catch {
    throw new Error('Local file must be an existing regular owner-only 0600 file.');
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function writeOwnerState(path, state) {
  const target = resolve(path);
  await assertExistingTargetSafe(target);
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await chmod(temp, 0o600);
    await assertExistingTargetSafe(target);
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

export async function readState(path, marker) {
  let state;
  try {
    state = JSON.parse(await readOwnerFile(path));
  } catch {
    throw new Error('Owner state is unavailable or is not valid private JSON.');
  }
  validateState(state, marker);
  return state;
}

export function validateState(state, marker) {
  if (!state || Array.isArray(state) || typeof state !== 'object')
    throw new Error('Owner state must be an object.');
  if (Object.keys(state).some((key) => !STATE_KEYS.has(key)))
    throw new Error('Owner state contains an unsupported field.');
  if (state.version !== 1 || state.marker !== marker)
    throw new Error('Owner state does not match this marker or version.');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(marker ?? '')) throw new Error('Marker is invalid.');

  const wantedNames = ['A', 'B', 'C'].map((suffix) => `MCP UX ${marker} ${suffix}`);
  if (
    !Array.isArray(state.account_names) ||
    JSON.stringify(state.account_names) !== JSON.stringify(wantedNames)
  )
    throw new Error('Owner state Account names do not match the marker.');
  if (state.activity_title !== `MCP UX ${marker} Activity`)
    throw new Error('Owner state Activity title does not match the marker.');

  const fixtureIds = state.planned_ids;
  if (!Array.isArray(fixtureIds) || fixtureIds.length !== 4 || fixtureIds.some((id) => !UUID.test(id)))
    throw new Error('Owner state must contain four valid planned fixture IDs.');
  if (new Set(fixtureIds.map((id) => id.toLowerCase())).size !== 4)
    throw new Error('Owner state planned fixture IDs must be unique.');
  if (
    !Array.isArray(state.account_ids) ||
    state.account_ids.length !== 3 ||
    state.account_ids.some((id) => !UUID.test(id))
  )
    throw new Error('Owner state must contain exactly three valid Account IDs.');
  if (new Set(state.account_ids.map((id) => id.toLowerCase())).size !== 3)
    throw new Error('Owner state Account IDs must be unique.');
  if (
    !UUID.test(state.activity_id) ||
    state.account_ids.some((id) => id.toLowerCase() === state.activity_id.toLowerCase())
  )
    throw new Error('Owner state requires a distinct valid Activity ID.');
  if (
    state.account_ids.some((id, index) => id.toLowerCase() !== fixtureIds[index].toLowerCase()) ||
    state.activity_id.toLowerCase() !== fixtureIds[3].toLowerCase()
  )
    throw new Error('Owner state fixture IDs differ from the saved plan.');
  if (
    !UUID.test(state.absent_probe_id) ||
    fixtureIds.some((id) => id.toLowerCase() === state.absent_probe_id.toLowerCase())
  )
    throw new Error('Owner state absence-probe ID must be a separate valid UUID.');
  if (!UUID.test(state.idempotency_key)) throw new Error('Owner state idempotency key is invalid.');

  for (const key of [
    'exercise_started',
    'exercise_completed',
    'fault_started',
    'fault_completed',
    'cleanup_started',
    'cleanup_completed',
  ]) {
    if (typeof state[key] !== 'boolean') throw new Error(`Owner state stage flag is invalid: ${key}.`);
  }
  if (state.batch_update_started !== undefined && typeof state.batch_update_started !== 'boolean')
    throw new Error('Owner state batch stage flag is invalid.');
}

export function createMutationGuard(fetchImpl, targetOrigin) {
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required.');
  let pinnedOrigin;
  try {
    const parsedOrigin = new URL(targetOrigin);
    if (
      parsedOrigin.protocol !== 'https:' ||
      parsedOrigin.origin !== targetOrigin ||
      parsedOrigin.username ||
      parsedOrigin.password ||
      parsedOrigin.pathname !== '/' ||
      parsedOrigin.search ||
      parsedOrigin.hash
    ) throw new Error();
    pinnedOrigin = parsedOrigin.origin;
  } catch {
    throw new Error('A valid exact HTTPS target origin is required.');
  }
  const permissions = [];
  const attempts = [];
  const readProbes = [];
  const blockedAttempts = [];

  const permit = ({ method, collection, id, body, fault = false, action = 'forward' }) => {
    const verb = String(method ?? '').toUpperCase();
    if (!['POST', 'PATCH', 'DELETE'].includes(verb) || !RECORD_COLLECTIONS.has(collection))
      throw new Error('Mutation permission rejected.');
    if (action !== 'forward' && action !== 'stub400') throw new Error('Mutation action rejected.');
    if (typeof fault !== 'boolean') throw new Error('Fault injection flag must be boolean.');
    if (fault && (verb !== 'PATCH' || action !== 'forward'))
      throw new Error('Fault injection is limited to forwarded PATCH.');
    const parsedBody = body;
    const authorizedId = id ?? (verb === 'POST' && isPlainObject(parsedBody) ? parsedBody.Id : undefined);
    if (!UUID.test(authorizedId ?? ''))
      throw new Error('Mutation permission requires an exact fixture UUID.');
    if (
      verb === 'POST' &&
      (!isPlainObject(parsedBody) ||
        !UUID.test(parsedBody.Id ?? '') ||
        parsedBody.Id.toLowerCase() !== authorizedId.toLowerCase())
    )
      throw new Error('Create permission must bind the body Id to the fixture UUID.');
    if (verb === 'PATCH' && !isPlainObject(parsedBody))
      throw new Error('Patch permission requires an exact object body.');
    if (verb === 'DELETE' && parsedBody !== undefined)
      throw new Error('Delete permission cannot include a body.');
    permissions.push({
      method: verb,
      collection,
      id: authorizedId.toLowerCase(),
      body: stable(parsedBody),
      fault,
      action,
      used: false,
    });
  };

  const guardedFetch = async (input, init = {}) => {
    let url;
    try {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
      url = new URL(raw);
    } catch {
      return block('Invalid request URL.');
    }
    if (url.origin !== pinnedOrigin || url.username || url.password)
      return block('Pinned target origin guard rejected the request.');

    const method = String(init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const bodyText = typeof init.body === 'string' ? init.body : undefined;
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    const isOdata = url.pathname === '/odata' || url.pathname.startsWith('/odata/');
    if (['x-http-method', 'x-http-method-override', 'x-method-override'].some((name) => headers.has(name)))
      return block('HTTP method override headers are blocked by the UX harness.');

    if (MUTATION_METHODS.has(method)) {
      if (method === 'PUT') return block('PUT is always blocked by the UX harness.');
      if (method === 'POST' && url.pathname === '/odata/$batch') {
        if (url.search || url.hash) return block('OData read probe URL must not contain extra parameters.');
        const request = parseExactReadProbe(bodyText, pinnedOrigin);
        if (!request) return block('OData batch is blocked unless it is one exact read-only probe.');
        readProbes.push({
          kind: 'nested_odata_get',
          collection: request.collection,
          method: 'GET',
          status: 405,
        });
        return new Response('', { status: 405 });
      }
      if (!isOdata) {
        if (
          method === 'POST' &&
          !url.search &&
          !url.hash &&
          READONLY_SERVICE_PATHS.has(url.pathname) &&
          allowedReadOnlyServicePost(url.pathname, bodyText)
        ) {
          const response = await fetchImpl(input, { ...init, redirect: 'manual' });
          if (response.status >= 300 && response.status < 400) return block('Redirect rejected.');
          readProbes.push({ kind: 'read_only_service_post', status: response.status });
          return response;
        }
        return block('Non-OData mutation is outside the exact read-only service allowlist.');
      }
      const mutation = exactMutationTarget(url, method, bodyText);
      if (!mutation) return block('OData mutation target is outside the exact fixture paths.');
      const permission = permissions.find(
        (candidate) =>
          !candidate.used &&
          candidate.method === method &&
          candidate.collection === mutation.collection &&
          candidate.id === mutation.id &&
          candidate.body === stable(mutation.body)
      );
      if (!permission) return block('OData mutation was not authorized by an exact one-shot rule.');

      permission.used = true;
      const event = {
        method,
        collection: mutation.collection,
        id: mutation.id,
        status: null,
        injected: permission.action === 'stub400',
        forwarded: false,
        forwarded_success: false,
        fault_requested: permission.fault,
        fault_injected: false,
      };
      attempts.push(event);
      if (permission.action === 'stub400') {
        event.status = 400;
        return new Response('', { status: 400 });
      }
      event.forwarded = true;
      let response;
      try {
        response = await fetchImpl(input, { ...init, redirect: 'manual' });
      } catch {
        event.status = 'transport_error';
        throw new Error('Authorized fixture mutation transport failed.');
      }
      event.status = response.status;
      event.forwarded_success = response.ok;
      if (response.status >= 300 && response.status < 400)
        throw new Error('Redirect rejected after fixture mutation dispatch.');
      if (permission.fault && response.ok) {
        event.injected = true;
        event.fault_injected = true;
        throw new Error('Injected local transport failure after one forwarded fixture PATCH.');
      }
      return response;
    }

    const response = await fetchImpl(input, { ...init, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) throw new Error('Redirect rejected.');
    return response;
  };

  function block(message) {
    blockedAttempts.push({ blocked: true });
    throw new Error(message);
  }

  function stats() {
    return {
      attempts: attempts.length,
      injected: attempts.filter((attempt) => attempt.injected).length,
      forwarded: attempts.filter((attempt) => attempt.forwarded).length,
      forwarded_successful: attempts.filter((attempt) => attempt.forwarded_success).length,
      blocked: blockedAttempts.length,
      read_probes: readProbes.length,
      statuses: attempts.map(
        ({
          method,
          collection,
          id,
          status,
          injected,
          fault_requested,
          fault_injected,
          forwarded,
          forwarded_success,
        }) => ({
          method,
          collection,
          id,
          status,
          injected,
          fault_requested,
          fault_injected,
          forwarded,
          forwarded_success,
        })
      ),
    };
  }

  return { permit, attempts, readProbes, blockedAttempts, guardedFetch, originalFetch: fetchImpl, stats };
}

function exactMutationTarget(url, method, bodyText) {
  if (url.search || url.hash) return undefined;
  const collectionNames = [...RECORD_COLLECTIONS].join('|');
  if (method === 'POST') {
    const match = new RegExp(`^/odata/(${collectionNames})$`).exec(url.pathname);
    if (!match) return undefined;
    const body = parseBody(bodyText);
    if (!isPlainObject(body) || !UUID.test(body.Id ?? '')) return undefined;
    return { collection: match[1], id: body.Id.toLowerCase(), body };
  }
  if (!['PATCH', 'DELETE'].includes(method)) return undefined;
  const match = new RegExp(
    `^/odata/(${collectionNames})\\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\\)$`,
    'i'
  ).exec(url.pathname);
  if (!match) return undefined;
  const collection = match[1];
  if (!RECORD_COLLECTIONS.has(collection)) return undefined;
  const body = method === 'PATCH' ? parseBody(bodyText) : undefined;
  if (method === 'PATCH' && !isPlainObject(body)) return undefined;
  if (method === 'DELETE' && bodyText !== undefined && bodyText !== '') return undefined;
  return { collection, id: match[2].toLowerCase(), body };
}

function parseExactReadProbe(bodyText, targetOrigin) {
  const body = parseBody(bodyText);
  if (
    !isPlainObject(body) ||
    Object.keys(body).length !== 1 ||
    !Array.isArray(body.requests) ||
    body.requests.length !== 1
  )
    return undefined;
  const request = body.requests[0];
  if (
    !isPlainObject(request) ||
    Object.keys(request).some((key) => !['id', 'method', 'url', 'headers'].includes(key)) ||
    request.method !== 'GET' ||
    request.id !== '1'
  )
    return undefined;
  if (
    request.headers !== undefined &&
    (!isPlainObject(request.headers) ||
      Object.keys(request.headers).some((key) => !['Accept', 'Content-Type'].includes(key)) ||
      (request.headers['Content-Type'] !== undefined &&
        request.headers['Content-Type'] !== 'application/json'))
  )
    return undefined;
  let nested;
  try {
    nested = new URL(request.url, targetOrigin);
  } catch {
    return undefined;
  }
  if (nested.origin !== targetOrigin || nested.username || nested.password || nested.hash) return undefined;
  const match = /^\/odata\/(Account|Activity)$/.exec(nested.pathname);
  if (
    !match ||
    nested.searchParams.size !== 2 ||
    nested.searchParams.get('$select') !== 'Id' ||
    nested.searchParams.get('$top') !== '1'
  )
    return undefined;
  return { collection: match[1] };
}

function parseBody(raw) {
  if (typeof raw !== 'string') return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function isPlainObject(value) {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function assertOwnerOnlyRegular(stat) {
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600)
    throw new Error('Local file must be a regular owner-only 0600 file.');
}

async function assertExistingTargetSafe(path) {
  try {
    const stat = await lstat(path);
    assertOwnerOnlyRegular(stat);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw new Error('Owner state target must be absent or a regular owner-only 0600 file.');
  }
}

function allowedReadOnlyServicePost(path, rawBody) {
  const body = parseBody(rawBody);
  if (!isPlainObject(body)) return false;
  if (path === '/ServiceModel/EntitySchemaDesignerService.svc/GetSchema')
    return Object.keys(body).length === 1 && UUID.test(body.schemaUId ?? '');
  if (
    path !== '/0/DataService/json/SyncReply/SelectQuery' ||
    body.rootSchemaName !== 'SysAdminUnit' ||
    body.operationType !== 0
  )
    return false;
  const expected = {
    Id: 'Id',
    Name: 'Name',
    ContactId: 'Contact.Id',
    ContactName: 'Contact.Name',
    ContactEmail: 'Contact.Email',
    CultureName: 'SysCulture.Name',
    TimeZoneId: 'TimeZoneId',
    UnitType: 'SysAdminUnitTypeValue',
  };
  const items = body.columns?.items;
  if (!items || stable(Object.keys(items).sort()) !== stable(Object.keys(expected).sort())) return false;
  for (const [name, columnPath] of Object.entries(expected))
    if (stable(items[name]) !== stable({ expression: { expressionType: 0, columnPath } })) return false;
  const filter = {
    filterType: 6,
    logicalOperation: 0,
    items: {
      current: {
        filterType: 1,
        comparisonType: 3,
        leftExpression: { expressionType: 0, columnPath: 'Id' },
        rightExpression: { expressionType: 1, functionType: 1, macrosType: 1 },
      },
    },
  };
  return (
    stable(body.filters) === stable(filter) &&
    stable(Object.keys(body).sort()) ===
      stable(['columns', 'filters', 'operationType', 'rootSchemaName'].sort())
  );
}

export function exactBody(value) {
  return stable(value);
}

function stable(value) {
  if (value === undefined) return '';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
