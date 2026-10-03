import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, parse, relative, resolve } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { HttpRequestOptions } from '../types/index.js';
import type { ServiceContainer } from '../tools/init-tool.js';
import { BpmApiError, formatToolError } from '../utils/errors.js';
import { tenantStorageScope, userStorageScope } from '../utils/tenant-scope.js';

export const MAX_OPERATION_BYTES = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Outcome = 'completed' | 'failed' | 'outcome_unknown';
export interface JournalMutationOutcome {
  status: Outcome;
  http_status?: number;
  receipt?: unknown;
}
export interface OperationStage {
  stage_id: number;
  status: 'started' | Outcome;
  method: string;
  target: string;
  intent?: unknown;
  started_at: string;
  finished_at?: string;
  http_status?: number;
  receipt?: unknown;
}
export interface OperationRecord {
  version: 1;
  operation_id: string;
  tenant_scope: string;
  user_scope: string;
  tool: string;
  status: 'started' | 'not_executed' | Outcome;
  started_at: string;
  finished_at?: string;
  intent: unknown;
  stages: OperationStage[];
  receipt?: unknown;
  requires_state_verification: boolean;
  safe_to_retry: false;
}
interface Namespace {
  root: string;
  directory: string;
  tenant: string;
  user: string;
}
interface JournalContext {
  namespace: Namespace;
  record: OperationRecord;
  pending: Promise<void>;
  failed: boolean;
}
export interface JournalMutationHandle {
  context: JournalContext;
  stage: OperationStage;
}
const storage = new AsyncLocalStorage<JournalContext>();

function unavailable(): BpmApiError {
  return new BpmApiError(
    'Не удалось надёжно сохранить журнал операции. Новое изменение не отправлено.',
    503,
    undefined,
    undefined,
    undefined,
    [
      'Проверьте доступность выделенного каталога журнала. При наличии operation_id проверьте операцию через bpm_get_operation.',
    ]
  );
}
function notFound(): BpmApiError {
  return new BpmApiError('Операция не найдена.', 404);
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function parentDirectories(path: string): Promise<void> {
  const firstCreated = await mkdir(path, { recursive: true });
  if (!firstCreated) return;
  let created = firstCreated;
  await syncDirectory(await realpath(dirname(created)));
  for (const segment of relative(firstCreated, path).split('/').filter(Boolean)) {
    await syncDirectory(await realpath(created));
    created = join(created, segment);
  }
}

async function privateDirectory(path: string, create: boolean): Promise<void> {
  let created = false;
  if (create) {
    try {
      await mkdir(path, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error;
    }
  }
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw unavailable();
  if (process.getuid && stat.uid !== process.getuid()) throw unavailable();
  if (created) await syncDirectory(dirname(path));
}

async function principal(services: ServiceContainer): Promise<{ user: string; tenant: string }> {
  await services.authManager.ensureAuthenticated();
  // The principal comes from BPMSoft's current-user macro, never an incoming user-id header.
  const user = userStorageScope((await services.currentUser.get()).userId);
  const tenant = tenantStorageScope(services.config);
  return { user, tenant };
}

async function namespace(
  services: ServiceContainer,
  create: boolean,
  verified?: { user: string; tenant: string }
): Promise<Namespace> {
  const { user, tenant } = verified ?? (await principal(services));
  const configured = resolve(services.config.journal_root || './state/operations');
  if (configured === parse(configured).root) throw unavailable();
  if (create) await parentDirectories(dirname(configured));
  // Resolve trusted parent aliases (/tmp, /var), but refuse a symbolic journal root itself.
  const parent = await realpath(dirname(configured));
  const root = join(parent, basename(configured));
  await privateDirectory(root, create);
  const tenantDirectory = join(root, tenant);
  await privateDirectory(tenantDirectory, create);
  const directory = join(tenantDirectory, user);
  await privateDirectory(directory, create);
  return { root, directory, tenant, user };
}

async function checkNamespace(value: Namespace): Promise<void> {
  await privateDirectory(value.root, false);
  await privateDirectory(join(value.root, value.tenant), false);
  await privateDirectory(value.directory, false);
}

const SECRET_KEY = /(?:password|passwd|authorization|cookie|csrf|token|secret|credential|api.?key)/i;
const BINARY_KEY = /(?:base64|binary|file_content|bytes|^data$)/i;
function safeText(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(sanitize(JSON.parse(value)));
    } catch {
      // Ordinary free text is still scrubbed below.
    }
  }
  return value
    .replace(/\b(?:Cookie|Set-Cookie|Authorization)\s*:\s*[^\r\n]+/gi, '[authentication header omitted]')
    .replace(/(?:\.ASPXAUTH|BPMSESSIONID|BPMCSRF|CsrfToken)\s*[=:]\s*[^;\s,"}]+/gi, '[credential omitted]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, '[authorization omitted]');
}

/** Keep business intent/receipts, omit credentials and binary payloads. */
function sanitize(value: unknown, key = '', depth = 0, seen = new Set<object>()): unknown {
  if (SECRET_KEY.test(key)) return '[redacted]';
  if (depth > 40) throw new BpmApiError('Журнал операции: слишком глубокая структура данных.', 400);
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return { binary_omitted: true, byte_length: value.byteLength };
  }
  if (typeof value === 'string') {
    if (BINARY_KEY.test(key) || /^data:[^;]+;base64,/i.test(value)) {
      return { binary_omitted: true, encoded_length: value.length };
    }
    return safeText(value);
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return undefined;
  if (seen.has(value)) throw new BpmApiError('Журнал операции: циклическая структура данных.', 400);
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => sanitize(item, '', depth + 1, seen));
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, sanitize(item, name, depth + 1, seen)])
    );
  } finally {
    seen.delete(value);
  }
}

async function atomicWrite(value: Namespace, id: string, text: string): Promise<void> {
  await checkNamespace(value);
  const path = join(value.directory, `${id}.json`);
  const temporary = join(value.directory, `.${id}.${randomUUID()}.tmp`);
  try {
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await checkNamespace(value);
    await rename(temporary, path);
    await syncDirectory(value.directory);
  } finally {
    await rm(temporary, { force: true });
  }
}

function persist(context: JournalContext): Promise<void> {
  let text: string;
  try {
    text = JSON.stringify(context.record);
    if (Buffer.byteLength(text, 'utf8') > MAX_OPERATION_BYTES) {
      throw new BpmApiError('Журнал операции превышает 2 MiB. Сузьте объём одной операции.', 413);
    }
  } catch (error) {
    context.failed = true;
    return Promise.reject(error);
  }
  const write = context.pending.then(() => atomicWrite(context.namespace, context.record.operation_id, text));
  context.pending = write.catch(() => {
    context.failed = true;
  });
  return write;
}

export async function beforeJournalMutation(
  options: HttpRequestOptions
): Promise<JournalMutationHandle | undefined> {
  const context = storage.getStore();
  const mutation =
    options.operation === 'mutation' || (options.operation !== 'read' && options.method !== 'GET');
  if (!context || !mutation || options.skipAuth) return undefined;
  if (context.failed) throw unavailable();
  const target = new URL(options.url);
  const stage: OperationStage = {
    stage_id: context.record.stages.length + 1,
    status: 'started',
    method: options.method,
    target: target.pathname,
    intent: sanitize({ body: options.body, query: Object.fromEntries(target.searchParams) }),
    started_at: new Date().toISOString(),
  };
  context.record.stages.push(stage);
  try {
    await persist(context);
  } catch (error) {
    if (error instanceof BpmApiError) throw error;
    throw unavailable();
  }
  return { context, stage };
}

export async function afterJournalMutation(
  handle: JournalMutationHandle | undefined,
  outcome: JournalMutationOutcome
): Promise<void> {
  if (!handle) return;
  if (handle.context.failed) throw unavailable();
  try {
    Object.assign(handle.stage, {
      status: outcome.status,
      finished_at: new Date().toISOString(),
      ...(outcome.http_status === undefined ? {} : { http_status: outcome.http_status }),
      ...(outcome.receipt === undefined ? {} : { receipt: sanitize(outcome.receipt) }),
    });
    await persist(handle.context);
  } catch {
    handle.context.failed = true;
    throw new BpmApiError(
      'Не удалось сохранить результат отправленного изменения. Сначала проверьте состояние операции.',
      503,
      undefined,
      undefined,
      undefined,
      ['Вызовите bpm_get_operation с operation_id. Не повторяйте изменение автоматически.'],
      'outcome_unknown'
    );
  }
}

export async function withOperationJournal(
  services: ServiceContainer,
  toolName: string,
  args: unknown,
  fn: () => Promise<CallToolResult>
): Promise<CallToolResult> {
  const value = await namespace(services, true);
  const record: OperationRecord = {
    version: 1,
    operation_id: randomUUID(),
    tenant_scope: value.tenant,
    user_scope: value.user,
    tool: toolName,
    status: 'started',
    started_at: new Date().toISOString(),
    intent: sanitize(args),
    stages: [],
    requires_state_verification: true,
    safe_to_retry: false,
  };
  const context: JournalContext = { namespace: value, record, pending: Promise.resolve(), failed: false };
  try {
    await persist(context);
  } catch (error) {
    if (error instanceof BpmApiError) throw error;
    throw unavailable();
  }
  let result: CallToolResult;
  try {
    result = await storage.run(context, fn);
  } catch (error) {
    const failure = formatToolError(error);
    result = {
      content: [{ type: 'text', text: JSON.stringify(failure) }],
      structuredContent: failure as unknown as Record<string, unknown>,
      isError: true,
    };
  }
  const uncertain =
    context.failed ||
    record.stages.some((stage) => stage.status === 'started' || stage.status === 'outcome_unknown') ||
    toolOutcomeUnknown(result);
  record.status = uncertain
    ? 'outcome_unknown'
    : record.stages.length === 0
      ? 'not_executed'
      : result.isError
        ? 'failed'
        : 'completed';
  record.requires_state_verification =
    uncertain || (record.status === 'failed' && record.stages.some((stage) => stage.status === 'completed'));
  record.finished_at = new Date().toISOString();
  const annotated: CallToolResult = {
    ...result,
    content: [
      {
        type: 'text',
        text: `operation_id: ${record.operation_id}. Проверка без повторного изменения: bpm_get_operation.`,
      },
      ...result.content,
    ],
    _meta: { ...result._meta, operation_id: record.operation_id },
  };
  if (!context.failed) {
    try {
      record.receipt = sanitize(annotated);
      await persist(context);
    } catch {
      context.failed = true;
    }
  }
  if (context.failed) {
    annotated._meta = {
      ...annotated._meta,
      operation_status: 'outcome_unknown',
      requires_state_verification: true,
      journal_receipt_persisted: false,
    };
    annotated.content.splice(1, 0, {
      type: 'text',
      text: 'Окончательный ответ не сохранён в журнале. Проверьте состояние через bpm_get_operation; не повторяйте изменение автоматически.',
    });
  }
  return annotated;
}

export async function getOperation(
  services: ServiceContainer,
  operationId: string
): Promise<OperationRecord> {
  if (!UUID.test(operationId)) throw notFound();
  const id = operationId.toLowerCase();
  const verified = await principal(services);
  let value: Namespace;
  try {
    value = await namespace(services, false, verified);
  } catch {
    throw notFound();
  }
  return readOperation(value, id);
}

async function readOperation(value: Namespace, id: string): Promise<OperationRecord> {
  try {
    await checkNamespace(value);
    const path = join(value.directory, `${id}.json`);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw notFound();
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let record: OperationRecord;
    try {
      const current = await handle.stat();
      if (current.size > MAX_OPERATION_BYTES) throw notFound();
      record = JSON.parse(await handle.readFile('utf8')) as OperationRecord;
    } finally {
      await handle.close();
    }
    if (
      record.version !== 1 ||
      record.operation_id !== id ||
      record.tenant_scope !== value.tenant ||
      record.user_scope !== value.user ||
      !Array.isArray(record.stages)
    )
      throw notFound();
    const incomplete =
      record.status === 'started' ||
      record.stages.some((stage) => stage.status === 'started' || stage.status === 'outcome_unknown');
    return {
      ...record,
      ...(incomplete ? { status: 'outcome_unknown', requires_state_verification: true } : {}),
      safe_to_retry: false,
    };
  } catch {
    throw notFound();
  }
}

export interface OperationList {
  operations: Array<
    Pick<
      OperationRecord,
      | 'operation_id'
      | 'tool'
      | 'status'
      | 'started_at'
      | 'finished_at'
      | 'requires_state_verification'
      | 'safe_to_retry'
    >
  >;
  offset: number;
  has_more: boolean;
  next_offset?: number;
  order: 'directory';
}

/** A bounded page in directory order. Concurrent changes can shift offsets; this is not a snapshot. */
export async function listOperations(
  services: ServiceContainer,
  options: { offset?: number; limit?: number } = {}
): Promise<OperationList> {
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 20;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 50
  ) {
    throw new BpmApiError('Журнал операции: offset должен быть неотрицательным, limit — от 1 до 50.', 400);
  }
  const empty: OperationList = { operations: [], offset, has_more: false, order: 'directory' };
  const verified = await principal(services);
  let value: Namespace;
  try {
    value = await namespace(services, false, verified);
  } catch {
    return empty;
  }
  await checkNamespace(value);
  const directory = await opendir(value.directory);
  const result = { ...empty };
  let position = 0;
  for await (const entry of directory) {
    if (!entry.name.endsWith('.json')) continue;
    const id = entry.name.slice(0, -5);
    if (!UUID.test(id)) continue;
    position += 1;
    if (position <= offset) continue;
    let record: OperationRecord;
    try {
      record = await readOperation(value, id.toLowerCase());
    } catch {
      continue;
    }
    if (result.operations.length >= limit) {
      result.has_more = true;
      result.next_offset = position - 1;
      break;
    }
    const {
      operation_id,
      tool,
      status,
      started_at,
      finished_at,
      requires_state_verification,
      safe_to_retry,
    } = record;
    result.operations.push({
      operation_id,
      tool,
      status,
      started_at,
      finished_at,
      requires_state_verification,
      safe_to_retry,
    });
  }
  return result;
}

function toolOutcomeUnknown(result: CallToolResult): boolean {
  const envelopes: unknown[] = [result.structuredContent];
  for (const content of result.content) {
    if (content.type !== 'text') continue;
    try {
      envelopes.push(JSON.parse(content.text));
    } catch {
      /* Human-readable result. */
    }
  }
  return envelopes.some((envelope) => {
    if (!envelope || typeof envelope !== 'object') return false;
    const value = envelope as Record<string, unknown>;
    if (value.code === 'outcome_unknown') return true;
    return (
      Array.isArray(value.outcomes) && value.outcomes.some((outcome) => outcome?.state === 'outcome_unknown')
    );
  });
}
