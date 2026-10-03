import { createHash } from 'node:crypto';
import type { BpmConfig } from '../types/index.js';
import { BpmApiError } from './errors.js';

/** Include the URL: reassigning a configured id must never reopen another stand's storage. */
export function tenantStorageScope(config: Pick<BpmConfig, 'bpmsoft_url' | 'tenant_id'>): string {
  const url = new URL(config.bpmsoft_url).toString().replace(/\/+$/, '');
  return createHash('sha256')
    .update(JSON.stringify([config.tenant_id ?? '', url]))
    .digest('hex');
}

/** Only a BPMSoft-verified SysAdminUnit UUID is accepted as a persistent identity. */
export function userStorageScope(userId: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId) ||
    /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(userId)
  )
    throw new BpmApiError('BPMSoft не подтвердил идентификатор пользователя.', 401);
  return createHash('sha256').update(userId.toLowerCase()).digest('hex');
}
