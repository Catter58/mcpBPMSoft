import { describe, expect, it, vi } from 'vitest';
import { BpmApiError } from '../../src/utils/errors.js';
import { verifyRecordState } from '../../src/read/record-verification.js';
import { buildClarifications, previewWriteChanges } from '../../src/utils/write-safety.js';
import type { ServiceContainer } from '../../src/tools/init-tool.js';

const ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const OTHER = 'bbbbbbbb-0000-0000-0000-000000000002';
const properties = [
  { name: 'Id', type: 'Edm.Guid' },
  { name: 'Amount', type: 'Edm.Decimal' },
  { name: 'When', type: 'Edm.DateTimeOffset' },
  { name: 'OwnerId', type: 'Edm.Guid', caption: 'Владелец', isLookup: true, lookupCollection: 'Contact' },
  { name: 'Blob', type: 'Edm.Stream' },
];

function servicesWith(
  read: (collection: string, id: string, query?: unknown) => Promise<Record<string, unknown>>
) {
  return {
    metadataManager: { getEntityMetadata: async () => ({ properties }) },
    odataClient: { getRecord: read },
    config: { odata_version: 4 },
  } as unknown as ServiceContainer;
}

describe('verifyRecordState', () => {
  it('compares exact decimals and equivalent date instants without implying causality', async () => {
    const getRecord = vi.fn(async () => ({ Amount: '1.00', When: '2026-10-07T09:00:00Z' }));
    const result = await verifyRecordState(servicesWith(getRecord), 'Account', ID, {
      operation: 'update',
      expected: { Amount: 1, When: '2026-10-07T12:00:00+03:00' },
    });
    expect(result).toMatchObject({ observation: 'matches', safe_to_retry: false, operation: 'update' });
    expect(result.observed_at).toBeTruthy();
    expect(getRecord).toHaveBeenCalledWith('Account', ID, { $select: 'Id,Amount,When' });
  });

  it.each([
    ['invalid GUID', { OwnerId: 'not-a-guid' }],
    ['malicious exponent', { Amount: '1e-1000000000' }],
    ['invalid calendar date', { When: '2026-02-30T10:00:00Z' }],
    ['unknown field', { UnknownField: 'x' }],
  ])('refuses %s before reading', async (_name, expected) => {
    const getRecord = vi.fn(async () => ({}));
    const result = await verifyRecordState(servicesWith(getRecord), 'Account', ID, {
      operation: 'update',
      expected,
    });
    expect(result.observation).toBe('unavailable');
    expect(getRecord).not.toHaveBeenCalled();
  });

  it.each(['create', 'update'] as const)(
    'reports a missing exact target as absent for %s',
    async (operation) => {
      const getRecord = vi.fn(async () => {
        throw new BpmApiError('not found', 404, 'Account');
      });
      const result = await verifyRecordState(servicesWith(getRecord), 'Account', ID, {
        operation,
        expected: operation === 'create' ? { Amount: '1.2' } : { Amount: '1.2' },
      });
      expect(result).toMatchObject({ observation: 'absent', safe_to_retry: false });
    }
  );

  it('reports DELETE absence as an observation only', async () => {
    const getRecord = vi.fn(async () => {
      throw new BpmApiError('not found', 404, 'Account');
    });
    expect(
      await verifyRecordState(servicesWith(getRecord), 'Account', ID, { operation: 'delete' })
    ).toMatchObject({ observation: 'absent', safe_to_retry: false });
  });

  it('does not compare a response that omits requested fields', async () => {
    const result = await verifyRecordState(
      servicesWith(async () => ({ Id: ID })),
      'Account',
      ID,
      {
        operation: 'update',
        expected: { Amount: 1 },
      }
    );
    expect(result).toMatchObject({
      observation: 'unavailable',
      differences: [{ field: 'Amount', actual_present: false }],
    });
  });

  it('does not call malformed server values a mismatch when they cannot be compared safely', async () => {
    const result = await verifyRecordState(
      servicesWith(async () => ({ Amount: 'not-a-decimal' })),
      'Account',
      ID,
      {
        operation: 'update',
        expected: { Amount: 1 },
      }
    );
    expect(result).toMatchObject({ observation: 'unavailable', safe_to_retry: false });
  });
});

describe('write presentation helpers', () => {
  it('keeps different lookup UUIDs visible even when the labels match', async () => {
    const services = {
      metadataManager: { getEntityMetadata: async () => ({ properties }) },
      config: { odata_version: 4 },
      odataClient: {
        getRecords: async () => ({
          value: [
            { Id: ID, Name: 'Одинаковое имя' },
            { Id: OTHER, Name: 'Одинаковое имя' },
          ],
        }),
      },
    } as unknown as ServiceContainer;
    const result = await previewWriteChanges(services, 'Account', { OwnerId: ID }, { OwnerId: OTHER });
    expect(result.changes[0]).toMatchObject({
      caption: 'Владелец',
      change: 'changed',
      before: `Одинаковое имя (${ID})`,
      after: `Одинаковое имя (${OTHER})`,
    });
  });

  it('falls back to raw values when presentation metadata is unavailable', async () => {
    const services = {
      metadataManager: {
        getEntityMetadata: async () => {
          throw new Error('metadata down');
        },
      },
    } as unknown as ServiceContainer;
    const result = await previewWriteChanges(services, 'Account', { Amount: 1 }, { Amount: 2 });
    expect(result.changes).toEqual([
      { field: 'Amount', caption: 'Amount', change: 'changed', before: 1, after: 2 },
    ]);
    expect(result.warnings).toContain(
      'Подписи и отображаемые значения полей недоступны; показаны технические имена и исходные значения.'
    );
  });

  it('returns direct partial argument patches for safe choices and no invented values for missing fields', () => {
    const result = buildClarifications([
      {
        field: 'OwnerId',
        caption: 'Владелец',
        lookup_collection: 'Contact',
        candidates: [
          { id: ID, displayValue: 'Иван' },
          { id: OTHER, displayValue: 'Иван' },
        ],
      },
      { missing_fields: [{ name: 'Name', caption: 'Название', type: 'Edm.String' }] },
    ]);
    expect(result[0]).toMatchObject({
      caption: 'Владелец',
      choices: [
        { label: `Иван (Contact) — ${ID}`, argument_patch: { data: { OwnerId: ID } } },
        { label: `Иван (Contact) — ${OTHER}`, argument_patch: { data: { OwnerId: OTHER } } },
      ],
    });
    expect(result[1]).toMatchObject({ field: 'Name', caption: 'Название' });
    expect(result[1]).not.toHaveProperty('choices');
    expect(
      buildClarifications([
        { field: 'StageId', argument_path: 'operations', operation: 'set_if_empty', valid_values: ['ready'] },
      ])[0]
    ).toMatchObject({
      apply_to: 'normalized_args',
      choices: [{ argument_patch: { data: { StageId: 'ready' } } }],
    });
    expect(buildClarifications([{ field: 'AccountId', valid_values: [ID] }], 'steps')[0]).toMatchObject({
      choices: [{ argument_patch: { record: { AccountId: ID } } }],
    });
  });
});
