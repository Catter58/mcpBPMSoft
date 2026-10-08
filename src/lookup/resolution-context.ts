import type { CurrentUser, CurrentUserService } from '../user/current-user.js';
import { isValidTimeZone } from '../utils/datetime.js';

export interface ResolutionTimeZone {
  timeZone: string;
  source: 'profile' | 'environment';
}

/** Shared per-operation snapshot for date and current-user resolution. */
export interface ResolutionContext {
  /** Captured once when the context is created; callers should treat it as read-only. */
  readonly now: Date;
  getCurrentUser(): Promise<CurrentUser>;
  getTimeZone(): Promise<ResolutionTimeZone>;
}

export function createResolutionContext(
  currentUser: CurrentUserService | undefined,
  now: Date = new Date(),
  environmentTimeZone: string | undefined = process.env.BPMSOFT_TIMEZONE
): ResolutionContext {
  const capturedNow = new Date(now.getTime());
  let currentUserPromise: Promise<CurrentUser> | undefined;
  let timeZonePromise: Promise<ResolutionTimeZone> | undefined;

  const getCurrentUser = (): Promise<CurrentUser> => {
    if (!currentUser) return Promise.reject(new Error('Current user service is unavailable.'));
    currentUserPromise ??= currentUser.get();
    return currentUserPromise;
  };

  const getTimeZone = (): Promise<ResolutionTimeZone> => {
    timeZonePromise ??= (async () => {
      if (!currentUser) throw new Error('Current user service is unavailable; timezone cannot be verified.');
      // An identity lookup failure must not silently change the interpretation
      // of a local timestamp to the process or environment timezone.
      const user = await getCurrentUser();
      if (user.timeZoneId && isValidTimeZone(user.timeZoneId))
        return { timeZone: user.timeZoneId, source: 'profile' };
      if (environmentTimeZone && isValidTimeZone(environmentTimeZone))
        return { timeZone: environmentTimeZone, source: 'environment' };
      throw new Error('No valid BPMSoft user or configured timezone is available.');
    })();
    return timeZonePromise;
  };

  return Object.freeze({
    get now() {
      return new Date(capturedNow.getTime());
    },
    getCurrentUser,
    getTimeZone,
  });
}
