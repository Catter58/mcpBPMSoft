import { AsyncLocalStorage } from 'node:async_hooks';
import { BpmApiError } from '../utils/errors.js';

export interface ReadBudgetLimits {
  timeoutMs: number;
  maxRequests: number;
  maxBytes: number;
}

interface ReadBudget {
  limits: ReadBudgetLimits;
  requests: number;
  bytes: number;
  controller: AbortController;
}

interface RequestRuntime {
  signal?: AbortSignal;
  budget?: ReadBudget;
}

const runtime = new AsyncLocalStorage<RequestRuntime>();

/** Bind disconnect cancellation to every upstream request in the async call stack. */
export function runWithRequestSignal<T>(signal: AbortSignal, fn: () => T): T {
  const current = runtime.getStore();
  return runtime.run({ ...current, signal }, fn);
}

export function getRequestSignal(): AbortSignal | undefined {
  return runtime.getStore()?.signal;
}

/** Stop waiting when a caller disconnects, including SDK JSON response waits. */
export function waitWithRequestSignal<T>(work: Promise<T>): Promise<T> {
  const signal = getRequestSignal();
  return signal ? waitWithSignal(work, signal) : work;
}

function waitWithSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      }
    );
    if (signal.aborted) abort();
  });
}

export function readBudgetExceeded(message: string): BpmApiError {
  return new BpmApiError(
    message,
    408,
    undefined,
    undefined,
    undefined,
    ['Сузьте выборку, запросите меньше полей или разбейте чтение на отдельные страницы.'],
    'budget_exceeded'
  );
}

/** A single tool's budget includes all concurrent reads, retries and redirects. */
export async function runWithReadBudget<T>(limits: ReadBudgetLimits, fn: () => T): Promise<Awaited<T>> {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid read budget: ${name}`);
  }
  const current = runtime.getStore();
  const controller = new AbortController();
  const budget: ReadBudget = { limits, requests: 0, bytes: 0, controller };
  const signal = current?.signal ? AbortSignal.any([current.signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => {
    controller.abort(readBudgetExceeded('Превышено время выполнения чтения.'));
  }, limits.timeoutMs);
  timer.unref();
  try {
    signal.throwIfAborted();
    const work = runtime.run({ signal, budget }, async () => {
      const value = await fn();
      // A handler may have caught an upstream error. Exhaustion still terminates the tool.
      signal.throwIfAborted();
      return value;
    });
    return (await waitWithSignal(work, signal)) as Awaited<T>;
  } finally {
    clearTimeout(timer);
    // Detached work cannot spend another tool's lifetime or continue after its response.
    if (!controller.signal.aborted) controller.abort(new DOMException('Read completed', 'AbortError'));
  }
}

/** Call immediately before each actual network attempt; never count a blocked attempt. */
export function countUpstreamRequest(): void {
  const context = runtime.getStore();
  context?.signal?.throwIfAborted();
  const budget = context?.budget;
  if (!budget) return;
  if (budget.requests >= budget.limits.maxRequests) {
    const error = readBudgetExceeded('Превышено количество запросов чтения к BPMSoft.');
    budget.controller.abort(error);
    throw error;
  }
  budget.requests++;
}

/** Charge streamed, decoded bytes before retaining a response chunk in memory. */
export function consumeReadBytes(bytes: number): void {
  const context = runtime.getStore();
  context?.signal?.throwIfAborted();
  const budget = context?.budget;
  if (!budget) return;
  if (bytes > budget.limits.maxBytes - budget.bytes) {
    const error = readBudgetExceeded('Превышен суммарный объём данных чтения.');
    budget.controller.abort(error);
    throw error;
  }
  budget.bytes += bytes;
}

interface QueuedAdmission {
  scope: string;
  signal: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  abort: () => void;
}

/** Bounded admission with per-credential fairness. No identity leaves this object. */
export class RequestAdmission {
  private active = 0;
  private readonly scopes = new Map<string, number>();
  private readonly queue: QueuedAdmission[] = [];

  constructor(
    private readonly maxActive = 500,
    private readonly maxQueued = 500,
    private readonly maxPerScope = 50
  ) {
    if (
      ![maxActive, maxPerScope].every((v) => Number.isSafeInteger(v) && v > 0) ||
      !Number.isSafeInteger(maxQueued) ||
      maxQueued < 0
    ) {
      throw new Error('Invalid HTTP admission limits');
    }
  }

  acquire(scope: string, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.canEnter(scope)) return Promise.resolve(this.enter(scope));
    if (this.queue.length >= this.maxQueued) {
      return Promise.reject(new BpmApiError('Сервер занят. Повторите запрос позже.', 429));
    }
    return new Promise((resolve, reject) => {
      const item: QueuedAdmission = {
        scope,
        signal,
        resolve,
        reject,
        abort: () => {
          const index = this.queue.indexOf(item);
          if (index !== -1) this.queue.splice(index, 1);
          reject(signal.reason);
        },
      };
      signal.addEventListener('abort', item.abort, { once: true });
      this.queue.push(item);
    });
  }

  private canEnter(scope: string): boolean {
    return this.active < this.maxActive && (this.scopes.get(scope) ?? 0) < this.maxPerScope;
  }

  private enter(scope: string): () => void {
    this.active++;
    this.scopes.set(scope, (this.scopes.get(scope) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      const count = (this.scopes.get(scope) ?? 1) - 1;
      if (count) this.scopes.set(scope, count);
      else this.scopes.delete(scope);
      this.drain();
    };
  }

  private drain(): void {
    // Skip a saturated identity so it cannot block other tenants/users.
    for (let index = 0; index < this.queue.length && this.active < this.maxActive; ) {
      const item = this.queue[index];
      if (!this.canEnter(item.scope)) {
        index++;
        continue;
      }
      this.queue.splice(index, 1);
      item.signal.removeEventListener('abort', item.abort);
      if (item.signal.aborted) item.reject(item.signal.reason);
      else item.resolve(this.enter(item.scope));
    }
  }
}
