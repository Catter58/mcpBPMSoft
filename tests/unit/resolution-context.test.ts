import { describe, expect, it, vi } from 'vitest';
import { createResolutionContext } from '../../src/lookup/resolution-context.js';
import type { CurrentUser } from '../../src/user/current-user.js';

const user = (timeZoneId?: string): CurrentUser => ({ userId: 'u1', userName: 'test', timeZoneId });

describe('ResolutionContext', () => {
  it('captures now as an immutable copy and memoizes current user retrieval', async () => {
    const captured = new Date('2026-09-22T22:30:00Z');
    const get = vi.fn(async () => user('Europe/Moscow'));
    const context = createResolutionContext({ get } as never, captured, 'UTC');
    captured.setUTCFullYear(2000);
    const exposed = context.now;
    exposed.setUTCFullYear(2001);
    expect(context.now.toISOString()).toBe('2026-09-22T22:30:00.000Z');
    await Promise.all([context.getCurrentUser(), context.getCurrentUser(), context.getTimeZone()]);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('uses profile timezone before configured fallback, then fallback only for missing profile zone', async () => {
    const profile = createResolutionContext(
      { get: async () => user('Europe/Moscow') } as never,
      undefined,
      'UTC'
    );
    expect(await profile.getTimeZone()).toEqual({ timeZone: 'Europe/Moscow', source: 'profile' });
    const fallback = createResolutionContext({ get: async () => user() } as never, undefined, 'UTC');
    expect(await fallback.getTimeZone()).toEqual({ timeZone: 'UTC', source: 'environment' });
  });

  it('fails closed when identity retrieval fails instead of using the timezone fallback', async () => {
    const context = createResolutionContext(
      {
        get: async () => {
          throw new Error('offline');
        },
      } as never,
      undefined,
      'UTC'
    );
    await expect(context.getTimeZone()).rejects.toThrow('offline');
  });

  it('requires a real profile lookup before accepting an explicit timezone fallback', async () => {
    const context = createResolutionContext(undefined, new Date(), 'UTC');
    await expect(context.getTimeZone()).rejects.toThrow(/Current user service is unavailable/);
  });
});
