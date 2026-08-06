/**
 * Сценарий пользователя: «обнови Активность, поставь результат "Выполнена"».
 *
 * Проверяет tool-уровень bpm_update_record:
 *  - ключ «Результат» (русский caption) → ResultId, значение по имени → UUID справочника;
 *  - неверное значение → ошибка с допустимыми значениями справочника (контекст для LLM).
 */

import { describe, it, expect } from 'vitest';
import { registerWriteTools } from '../../src/tools/write-tools.js';
import { LookupResolver } from '../../src/lookup/lookup-resolver.js';
import type { ServiceContainer } from '../../src/tools/init-tool.js';
import type { BpmConfig } from '../../src/types/index.js';

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface RegisteredTool {
  name: string;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

function buildFakeServer(): {
  registered: RegisteredTool[];
  registerTool: (n: string, m: unknown, h: RegisteredTool['handler']) => void;
} {
  const registered: RegisteredTool[] = [];
  return {
    registered,
    registerTool(name, _meta, handler) {
      registered.push({ name, handler });
    },
  };
}

function makeCfg(): BpmConfig {
  return {
    bpmsoft_url: 'https://bpm.test',
    odata_version: 4,
    platform: 'net8',
    page_size: 100,
    max_batch_size: 100,
    lookup_cache_ttl: 300,
    request_timeout: 30000,
    max_file_size: 10 * 1024 * 1024,
  };
}

const ACTIVITY_RESULTS = [
  { Id: 'r1', Name: 'Выполнена' },
  { Id: 'r2', Name: 'Отменена' },
  { Id: 'r3', Name: 'Перенесена' },
];

function buildServices(
  updated: Array<{ collection: string; id: string; data: Record<string, unknown> }>
): ServiceContainer {
  const odataClient = {
    async getRecords(collection: string, query?: { $filter?: string }) {
      if (collection !== 'ActivityResult') return { value: [] };
      const f = query?.$filter;
      if (f === undefined) return { value: ACTIVITY_RESULTS };
      const eq = /eq '(.+)'$/.exec(f);
      if (eq) return { value: ACTIVITY_RESULTS.filter((r) => r.Name === eq[1].replace(/''/g, "'")) };
      const sub = /'(.+?)'/.exec(f);
      const needle = sub ? sub[1] : '';
      return { value: ACTIVITY_RESULTS.filter((r) => r.Name.toLowerCase().includes(needle)) };
    },
    async updateRecord(collection: string, id: string, data: Record<string, unknown>) {
      updated.push({ collection, id, data });
    },
  };
  const metadataManager = {
    async getEntityMetadata() {
      return { properties: [], lookupFields: [] };
    },
    async resolveFieldReference(_c: string, key: string) {
      return { name: key === 'Результат' ? 'ResultId' : key };
    },
    async getLookupInfo(_c: string, field: string) {
      return field === 'ResultId' ? { lookupCollection: 'ActivityResult', displayColumn: 'Name' } : null;
    },
  };
  const container: ServiceContainer = {
    config: makeCfg(),
    httpClient: null!,
    authManager: { async ensureAuthenticated() {} } as never,
    odataClient: odataClient as never,
    metadataManager: metadataManager as never,
    lookupResolver: null!,
    processEngine: null!,
    initialized: true,
  };
  container.lookupResolver = new LookupResolver(
    container.config,
    odataClient as never,
    metadataManager as never
  );
  return container;
}

async function callUpdate(services: ServiceContainer, args: Record<string, unknown>): Promise<ToolResult> {
  const server = buildFakeServer();
  registerWriteTools(server as never, services);
  const tool = server.registered.find((t) => t.name === 'bpm_update_record');
  return tool!.handler(args);
}

describe('bpm_update_record: справочники по имени', () => {
  it('«Результат»: «Выполнена» → ResultId=UUID из ActivityResult', async () => {
    const updated: Array<{ collection: string; id: string; data: Record<string, unknown> }> = [];
    const services = buildServices(updated);
    const result = await callUpdate(services, {
      collection: 'Activity',
      id: 'act-1',
      data: { Результат: 'Выполнена' },
    });
    expect(result.isError).toBeFalsy();
    expect(updated).toHaveLength(1);
    expect(updated[0].data).toEqual({ ResultId: 'r1' });
    expect((result.structuredContent as { updated_fields: string[] }).updated_fields).toEqual(['ResultId']);
  });

  it('регистр и лишние кавычки не мешают: «выполнена» тоже резолвится', async () => {
    const updated: Array<{ collection: string; id: string; data: Record<string, unknown> }> = [];
    const services = buildServices(updated);
    const result = await callUpdate(services, {
      collection: 'Activity',
      id: 'act-1',
      data: { Результат: 'выполнена' },
    });
    expect(result.isError).toBeFalsy();
    expect(updated[0].data).toEqual({ ResultId: 'r1' });
    const sc = result.structuredContent as { resolved_lookups?: Array<{ matched_value: string }> };
    expect(sc.resolved_lookups?.[0].matched_value).toBe('Выполнена');
  });

  it('неверное значение → ошибка со списком допустимых значений справочника', async () => {
    const updated: Array<{ collection: string; id: string; data: Record<string, unknown> }> = [];
    const services = buildServices(updated);
    const result = await callUpdate(services, {
      collection: 'Activity',
      id: 'act-1',
      data: { Результат: 'Сделано' },
    });
    expect(result.isError).toBe(true);
    expect(updated).toHaveLength(0);
    const text = result.content[0].text;
    expect(text).toContain('Допустимые значения');
    expect(text).toContain('Выполнена');
    expect(text).toContain('ActivityResult');
  });
});
