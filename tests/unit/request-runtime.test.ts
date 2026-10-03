import { describe, expect, it } from 'vitest';
import {
  RequestAdmission,
  countUpstreamRequest,
  runWithReadBudget,
} from '../../src/server/request-runtime.js';

describe('bounded HTTP admission', () => {
  it('caps active requests, rejects overflow and admits the queue on release', async () => {
    const admission = new RequestAdmission(1, 1, 1);
    const signal = new AbortController().signal;
    const release = await admission.acquire('a', signal);
    const pending = admission.acquire('b', signal);
    await expect(admission.acquire('c', signal)).rejects.toMatchObject({ httpStatus: 429 });
    release();
    const releaseNext = await pending;
    releaseNext();
    releaseNext(); // Cleanup is idempotent.
    (await admission.acquire('c', signal))();
  });

  it('removes disconnected callers from the bounded queue', async () => {
    const admission = new RequestAdmission(1, 1, 1);
    const controller = new AbortController();
    const signal = new AbortController().signal;
    const release = await admission.acquire('active', signal);
    const disconnected = admission.acquire('queued', controller.signal);
    const failure = expect(disconnected).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await failure;
    const replacement = admission.acquire('replacement', signal);
    release();
    (await replacement)();
  });

  it('a saturated user cannot block another user or tenant', async () => {
    const admission = new RequestAdmission(2, 3, 1);
    const signal = new AbortController().signal;
    const releaseA = await admission.acquire('tenant-a:user-a', signal);
    const pendingA = admission.acquire('tenant-a:user-a', signal);
    const releaseB = await admission.acquire('tenant-b:user-a', signal);
    const pendingC = admission.acquire('tenant-a:user-c', signal);
    releaseB();
    const releaseC = await pendingC;
    releaseC();
    releaseA();
    (await pendingA)();
  });
});

describe('read budgets', () => {
  it('ends an unresponsive handler on timeout and blocks its late upstream work', async () => {
    let continueWork!: () => void;
    let blocked = false;
    const gate = new Promise<void>((resolve) => {
      continueWork = resolve;
    });
    const result = runWithReadBudget({ timeoutMs: 20, maxRequests: 1, maxBytes: 1 }, async () => {
      await gate;
      try {
        countUpstreamRequest();
      } catch {
        blocked = true;
      }
    });
    await expect(result).rejects.toMatchObject({ code: 'budget_exceeded' });
    continueWork();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(blocked).toBe(true);
  });
});
