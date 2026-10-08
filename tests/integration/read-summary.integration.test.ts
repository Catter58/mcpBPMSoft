import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { initializeServices } from '../../src/tools/init-tool.js';
import { createToolServer } from '../../src/server/tool-server.js';
import { runWithAuth } from '../../src/auth/request-context.js';
import { createSyntheticSession, recordId } from '../../scripts/lib/context-budget.mjs';

const runtime = { initializeServices, createToolServer, runWithAuth };
let session: Awaited<ReturnType<typeof createSyntheticSession>>;

beforeAll(async () => {
  vi.stubEnv('BPMSOFT_METADATA_CACHE', 'off');
  session = await createSyntheticSession({ totalRows: 2, notesBytes: 16 }, runtime);
});

afterAll(async () => {
  await session?.close();
  vi.unstubAllEnvs();
});

describe('summary format through MCP Client', () => {
  it('keeps the complete structured result and warnings while reducing the full result envelope', async () => {
    const args = {
      collection: 'Contact',
      select: 'Id,Name',
      auto_paginate: true,
      max_records: 2,
      count: true,
      resolve_references: false,
    };
    const baseline = await session.call('bpm_get_records', args);
    const summary = await session.call('bpm_get_records', { ...args, format: 'summary' });

    expect(baseline.result.isError).toBeFalsy();
    expect(summary.result.isError).toBeFalsy();
    expect(summary.result.structuredContent).toEqual(baseline.result.structuredContent);
    expect(summary.result.structuredContent).toMatchObject({ count: 2, total_count: 2, has_more: false });
    expect(summary.result.structuredContent.warnings).toEqual(baseline.result.structuredContent.warnings);
    const text = summary.result.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    expect(text).toContain('Коллекция: Contact');
    expect(text).toContain('Получено записей: 2');
    expect(text).toContain('Всего записей: 2');
    expect(text).not.toContain(recordId(1));
    expect(text).not.toContain('Контакт 000001');
    expect(text).not.toContain('Контакт 000002');
    expect(summary.metrics.result_bytes).toBeLessThan(baseline.metrics.result_bytes);
    expect(summary.metrics.structured_bytes).toBe(baseline.metrics.structured_bytes);
  });

  it('inherits summary text and lookup-resolution choice on a cursor-only continuation', async () => {
    const first = await session.call('bpm_get_records', {
      collection: 'Contact',
      select: 'Id,Name',
      top: 1,
      count: true,
      resolve_references: false,
      format: 'summary',
    });
    expect(first.result.isError).toBeFalsy();
    expect(first.result.structuredContent).toMatchObject({ count: 1, total_count: 2, has_more: true });
    expect(first.result.structuredContent.records[0].Id).toBe(recordId(1));
    const firstText = first.result.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    expect(firstText).not.toContain(recordId(1));
    expect(firstText).not.toContain('Контакт 000001');

    const second = await session.call('bpm_get_records', {
      cursor: first.result.structuredContent.cursor,
    });
    expect(second.result.isError).toBeFalsy();
    expect(second.result.structuredContent).toMatchObject({ count: 1, total_count: 2, has_more: false });
    expect(second.result.structuredContent.records[0].Id).toBe(recordId(2));
    const secondText = second.result.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    expect(secondText).toContain('Коллекция: Contact');
    expect(secondText).toContain('Всего записей: 2');
    expect(secondText).not.toContain(recordId(2));
    expect(secondText).not.toContain('Контакт 000002');
    expect(second.result.structuredContent.warnings).toEqual(first.result.structuredContent.warnings);
  });
});
