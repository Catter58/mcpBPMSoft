import { readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import * as z from 'zod';
import { buildConfig, tryLoadConfigFromEnv, isEnvCredsAllowed } from '../config.js';
import { initializeServices, type ServiceContainer } from '../tools/init-tool.js';
import { BpmApiError } from '../utils/errors.js';

const tenantSchema = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
  url: z.string().min(1),
  odata_version: z.union([z.literal(3), z.literal(4)]).optional(),
  platform: z.enum(['net8', 'netframework']).optional(),
});
const registrySchema = z.strictObject({ tenants: z.array(tenantSchema).min(1).max(1000) });

/** Fixed operator allowlist. Requests select ids; URLs and credentials are never configuration inputs. */
export class TenantRegistry {
  private readonly services = new Map<string, ServiceContainer>();

  constructor(
    configurations: Array<{ id: string; config: ServiceContainer['config'] }>,
    readonly multitenant: boolean,
    allowEnvCreds = false
  ) {
    if (multitenant && allowEnvCreds)
      throw new Error('Мультитенантный HTTP не допускает общую учётную запись env-creds.');
    for (const { id, config } of configurations) {
      if (this.services.has(id)) throw new Error('Идентификаторы стендов должны быть уникальны.');
      this.services.set(id, initializeServices(config, allowEnvCreds));
    }
  }

  resolveTenant(req: Pick<IncomingMessage, 'url'>): string {
    // Exact matching rejects query strings and encoded path separators as well.
    const match = this.multitenant
      ? /^\/tenants\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})\/mcp$/.exec(req.url ?? '')
      : null;
    const id =
      match?.[1] ??
      (!this.multitenant && ['/', '/mcp'].includes(req.url ?? '')
        ? this.services.keys().next().value
        : undefined);
    if (!id || !this.services.has(id)) throw new BpmApiError('Стенд или путь MCP недоступен.', 404);
    return id;
  }

  get(id: string): ServiceContainer {
    const services = this.services.get(id);
    if (!services) throw new BpmApiError('Стенд недоступен.', 404);
    return services;
  }
}

export function loadTenantRegistry(): TenantRegistry {
  const multitenant = /^(true|1|on)$/i.test(process.env.BPMSOFT_MULTITENANT ?? '');
  const file = process.env.BPMSOFT_TENANTS_FILE;
  if (multitenant) {
    if (!file) throw new Error('Для BPMSOFT_MULTITENANT задайте BPMSOFT_TENANTS_FILE.');
    if (isEnvCredsAllowed()) throw new Error('BPMSOFT_TENANTS_FILE несовместим с BPMSOFT_ALLOW_ENV_CREDS.');
    const parsed = registrySchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    if (!parsed.success) throw new Error('Некорректная конфигурация BPMSOFT_TENANTS_FILE.');
    return new TenantRegistry(
      parsed.data.tenants.map((tenant) => ({
        id: tenant.id,
        config: {
          ...buildConfig(tenant.url, undefined, undefined, tenant),
          tenant_id: tenant.id,
          journal_root: process.env.BPMSOFT_JOURNAL_ROOT || './state/operations',
        },
      })),
      true
    );
  }
  const config = tryLoadConfigFromEnv();
  if (!config) throw new Error('BPMSOFT_URL обязателен в режиме одного стенда.');
  return new TenantRegistry([{ id: 'default', config }], false, isEnvCredsAllowed());
}
