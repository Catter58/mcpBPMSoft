/**
 * «Я» в данных и фильтрах.
 *
 * Модель пишет «мои активности» или «ответственный — я». Звать bpm_whoami и
 * переносить contact_id руками она не должна: сервер сам подставляет текущего
 * пользователя в lookup на Contact (контакт) или SysAdminUnit (учётная запись).
 */

import type { CurrentUser } from '../user/current-user.js';

const ME_TOKENS = new Set(['@me', 'me', 'я', 'мне', 'меня', 'текущий пользователь']);

export function isMeMacro(value: unknown): value is string {
  return typeof value === 'string' && ME_TOKENS.has(value.trim().toLowerCase());
}

/** Id текущего пользователя для lookup на справочник или null, если «я» к нему неприменимо. */
export function meIdFor(lookupCollection: string, user: CurrentUser): string | null {
  // v3 называет EntitySet с суффиксом Collection.
  const entity = lookupCollection.replace(/Collection$/, '');
  if (entity === 'Contact') return user.contactId ?? null;
  if (entity === 'SysAdminUnit') return user.userId;
  return null;
}
