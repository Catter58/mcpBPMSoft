/**
 * bpm_batch_create / bpm_batch_update / bpm_batch_delete: поштучные ошибки,
 * имена вместо UUID, match_on/if_exists и превью удаления с названиями.
 */

import { describe, it, expect } from 'vitest';
import { registerBatchTools } from '../../src/tools/batch-tools.js';
import type { ServiceContainer } from '../../src/tools/init-tool.js';

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;
type Req = { method: string; url: string; body?: Record<string, unknown> };

const ALPHA = 'aaaaaaaa-0000-0000-0000-000000000001';
const BETA = 'aaaaaaaa-0000-0000-0000-000000000002';

interface State {
  bulk: Req[][];
  filters: string[];
  rows: Array<Record<string, unknown>>;
}

function setup(rows: Array<Record<string, unknown>> = []): { state: State; tool: (n: string) => Handler } {
  const state: State = { bulk: [], filters: [], rows };
  const props = [
    { name: 'Id', type: 'Edm.Guid' },
    { name: 'Name', type: 'Edm.String' },
    { name: 'Email', type: 'Edm.String' },
  ];
  const services = {
    config: { odata_version: 4 },
    initialized: true,
    authManager: { ensureAuthenticated: async () => undefined },
    metadataManager: {
      getEntityMetadata: async () => ({ properties: props }),
      resolveCollectionReference: async (c: string) => ({ name: c }),
      resolveFieldReference: async (_c: string, q: string) => {
        const p = props.find((x) => x.name.toLowerCase() === q.toLowerCase());
        return p ? { name: p.name } : { name: null, suggestions: ['Name'] };
      },
    },
    lookupResolver: {
      resolveDataLookups: async (_c: string, data: Record<string, unknown>) => {
        if (data.Account === 'BAD') throw new Error('Account "BAD" не найден');
        return { data: { ...data }, notes: [] };
      },
      // «Альфа» — точное совпадение; «Альф» находится только нечётко.
      resolve: async (_c: string, value: string, _col: string, opts: { fuzzy?: boolean } = {}) => {
        if (value === 'Альфа' || (value === 'Альф' && opts.fuzzy)) {
          return {
            resolved: true,
            id: ALPHA,
            matchCount: 1,
            candidates: [{ id: ALPHA, displayValue: 'Альфа' }],
            matchedValue: 'Альфа',
          };
        }
        return { resolved: false, matchCount: 0, candidates: [] };
      },
    },
    odataClient: {
      buildCollectionPath: (c: string) => `/${c}`,
      buildRecordPath: (c: string, id: string) => `/${c}(${id})`,
      getRecords: async (_c: string, q: { $filter?: string }) => {
        state.filters.push(q.$filter ?? '');
        return { value: state.rows };
      },
      executeBulk: async (requests: Req[]) => {
        state.bulk.push(requests);
        return {
          mode: 'batch',
          responses: requests.map((r, i) =>
            r.body?.Name === 'FAIL'
              ? { status: 400, body: { error: { code: '', message: 'Поле Name обязательно' } } }
              : {
                  status: r.method === 'POST' ? 201 : 204,
                  body: r.method === 'POST' ? { Id: `new-${i}` } : null,
                }
          ),
        };
      },
    },
  };
  const handlers = new Map<string, Handler>();
  registerBatchTools(
    { registerTool: (name: string, _m: unknown, h: Handler) => handlers.set(name, h) } as never,
    services as unknown as ServiceContainer
  );
  return { state, tool: (n) => handlers.get(n)! };
}

describe('bpm_batch_create', () => {
  it('lists "#n name → Id" and keeps created aligned by index', async () => {
    const { tool } = setup();
    const r = await tool('bpm_batch_create')({
      collection: 'Account',
      records: [{ Name: 'A' }, { Name: 'B' }],
    });
    expect(r.content[0].text).toContain('#1 A → new-0');
    expect(r.content[0].text).toContain('#2 B → new-1');
    expect(r.structuredContent?.created).toEqual(['new-0', 'new-1']);
  });

  it('continue_on_error skips a record whose lookup fails and reports it by index', async () => {
    const { state, tool } = setup();
    const r = await tool('bpm_batch_create')({
      collection: 'Account',
      records: [{ Name: 'A', Account: 'BAD' }, { Name: 'B' }],
      continue_on_error: true,
    });
    expect(state.bulk[0]).toHaveLength(1);
    expect(r.structuredContent?.created).toEqual([null, 'new-0']);
    expect(r.structuredContent?.errors).toEqual([{ index: 0, reason: expect.stringContaining('BAD') }]);
    expect(r.isError).toBe(false);
  });

  it('without continue_on_error a lookup failure sends nothing', async () => {
    const { state, tool } = setup();
    const r = await tool('bpm_batch_create')({
      collection: 'Account',
      records: [{ Name: 'A' }, { Name: 'B', Account: 'BAD' }],
    });
    expect(state.bulk).toHaveLength(0);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('#2 B');
  });

  it('sub-request errors show the BPMSoft message, not raw JSON', async () => {
    const { tool } = setup();
    const r = await tool('bpm_batch_create')({
      collection: 'Account',
      records: [{ Name: 'FAIL' }],
    });
    expect(r.content[0].text).toContain('HTTP 400 — Поле Name обязательно');
    expect(r.content[0].text).not.toContain('"error"');
  });

  it('match_on + skip: existing record (case-insensitive) is not created; literals are escaped', async () => {
    const { state, tool } = setup([{ Id: BETA, Name: "o'brien" }]);
    const r = await tool('bpm_batch_create')({
      collection: 'Account',
      records: [{ Name: "O'Brien" }, { Name: 'New' }],
      match_on: ['name'],
    });
    expect(state.filters[0]).toBe("(Name eq 'O''Brien') or (Name eq 'New')");
    expect(state.bulk[0]).toEqual([{ method: 'POST', url: '/Account', body: { Name: 'New' } }]);
    expect(r.structuredContent?.existing).toEqual([BETA, null]);
    expect(r.structuredContent?.created).toEqual([null, 'new-0']);
    expect(r.content[0].text).toContain(`уже есть: ${BETA}`);
  });

  it('match_on + update: PATCHes the existing record', async () => {
    const { state, tool } = setup([{ Id: BETA, Email: 'a@x.ru' }]);
    const r = await tool('bpm_batch_create')({
      collection: 'Contact',
      records: [{ Name: 'A', Email: 'A@x.ru' }],
      match_on: ['Email'],
      if_exists: 'update',
    });
    expect(state.bulk[0]).toEqual([
      { method: 'PATCH', url: `/Contact(${BETA})`, body: { Name: 'A', Email: 'A@x.ru' } },
    ]);
    expect(r.structuredContent?.updated).toEqual([BETA]);
  });

  it('match_on + error without continue_on_error sends nothing', async () => {
    const { state, tool } = setup([{ Id: BETA, Name: 'A' }]);
    const r = await tool('bpm_batch_create')({
      collection: 'Account',
      records: [{ Name: 'A' }, { Name: 'B' }],
      match_on: ['Name'],
      if_exists: 'error',
    });
    expect(state.bulk).toHaveLength(0);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain(`уже есть: ${BETA}`);
  });

  it('unknown match_on column is a clear error', async () => {
    const { state, tool } = setup();
    const r = await tool('bpm_batch_create')({
      collection: 'Account',
      records: [{ Name: 'A' }],
      match_on: ['Phone'],
    });
    expect(state.bulk).toHaveLength(0);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('Phone');
  });
});

describe('bpm_batch_update', () => {
  it('resolves names to Id; a miss is a per-item error with continue_on_error', async () => {
    const { state, tool } = setup();
    const r = await tool('bpm_batch_update')({
      collection: 'Account',
      updates: [
        { id: 'Альф', data: { Name: 'X' } },
        { id: 'Нет такой', data: { Name: 'Y' } },
      ],
      continue_on_error: true,
    });
    expect(state.bulk[0]).toEqual([{ method: 'PATCH', url: `/Account(${ALPHA})`, body: { Name: 'X' } }]);
    expect(r.structuredContent?.ids).toEqual([ALPHA, null]);
    expect(r.structuredContent?.errors).toEqual([{ index: 1, reason: expect.any(String) }]);
    expect(r.content[0].text).toContain('«Альф» → Альфа');
  });

  it('without continue_on_error a miss sends nothing', async () => {
    const { state, tool } = setup();
    const r = await tool('bpm_batch_update')({
      collection: 'Account',
      updates: [
        { id: ALPHA, data: { Name: 'X' } },
        { id: 'Нет такой', data: { Name: 'Y' } },
      ],
    });
    expect(state.bulk).toHaveLength(0);
    expect(r.isError).toBe(true);
  });
});

describe('bpm_batch_delete', () => {
  it('preview lists "Name (Id)" for names and UUIDs', async () => {
    const { state, tool } = setup([{ Id: BETA, Name: 'Бета' }]);
    const r = await tool('bpm_batch_delete')({ collection: 'Account', ids: ['Альфа', BETA] });
    expect(state.bulk).toHaveLength(0);
    expect(r.structuredContent?.requires_confirmation).toBe(true);
    expect(r.content[0].text).toContain(`#1 Альфа (${ALPHA})`);
    expect(r.content[0].text).toContain(`#2 Бета (${BETA})`);
    expect(r.structuredContent?.ids).toEqual([ALPHA, BETA]);
  });

  it('never deletes a fuzzy-only name match', async () => {
    const { state, tool } = setup([{ Id: BETA, Name: 'Бета' }]);
    const r = await tool('bpm_batch_delete')({
      collection: 'Account',
      ids: ['Альф', BETA],
      confirm: true,
      continue_on_error: true,
    });
    expect(state.bulk[0]).toEqual([{ method: 'DELETE', url: `/Account(${BETA})` }]);
    expect(r.structuredContent?.errors).toEqual([{ index: 0, reason: expect.stringContaining('точное') }]);
  });

  it('without continue_on_error an unknown name aborts before deleting', async () => {
    const { state, tool } = setup([{ Id: BETA, Name: 'Бета' }]);
    const r = await tool('bpm_batch_delete')({ collection: 'Account', ids: ['Альф', BETA], confirm: true });
    expect(state.bulk).toHaveLength(0);
    expect(r.isError).toBe(true);
  });
});
