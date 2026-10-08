import { describe, expect, it, vi } from 'vitest';
import type { ServiceContainer } from '../../src/tools/init-tool.js';
import { resolveRecordTarget } from '../../src/tools/_guards.js';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function setup(rows: Array<Record<string, unknown>>) {
  const metadata = {
    name: 'Contact',
    collectionName: 'Contact',
    keyFields: ['Id'],
    properties: [
      { name: 'Id', caption: 'Id', type: 'Edm.Guid' },
      { name: 'Name', caption: 'Name', type: 'Edm.String' },
      { name: 'ExternalCode', caption: 'External code', type: 'Edm.String' },
      { name: 'AccountId', caption: 'Account', type: 'Edm.Guid', isLookup: true },
    ],
  };
  const services = {
    config: { odata_version: 4 },
    metadataManager: {
      getEntityMetadata: vi.fn(async () => metadata),
      resolveFieldReference: vi.fn(async (_collection: string, field: string) => ({
        name: field,
        autoCorrected: false,
      })),
      getLookupInfo: vi.fn(async (_collection: string, field: string) =>
        field === 'AccountId' ? { lookupCollection: 'Account', displayColumn: 'Name' } : undefined
      ),
    },
    lookupResolver: {
      resolveDataLookups: vi.fn(async (_collection: string, data: Record<string, unknown>) => ({
        data,
        notes: [],
        coerced: [],
        origins: [],
      })),
      resolve: vi.fn(async () => ({ resolved: true, id: A, matchCount: 1, candidates: [] })),
    },
    odataClient: { getRecords: vi.fn(async () => ({ value: rows })) },
  } as unknown as ServiceContainer;
  return services;
}

describe('resolveRecordTarget business keys', () => {
  it('resolves exact conjunctions and reports canonical fields/values', async () => {
    const services = setup([{ Id: A, Name: 'Acme', ExternalCode: 'A-1' }]);
    const result = await resolveRecordTarget(services, 'Contact', {
      match_by: [
        { field: 'ExternalCode', value: 'A-1' },
        { field: 'Name', value: 'Acme' },
      ],
    });
    expect(result).toEqual({
      id: A,
      matched_by: {
        fields: [
          { field: 'ExternalCode', caption: 'External code', type: 'Edm.String' },
          { field: 'Name', caption: 'Name', type: 'Edm.String' },
        ],
        values: { ExternalCode: 'A-1', Name: 'Acme' },
      },
    });
    expect(services.odataClient.getRecords).toHaveBeenCalledWith(
      'Contact',
      expect.objectContaining({ $top: 2, $filter: "(ExternalCode eq 'A-1') and (Name eq 'Acme')" }),
      true,
      2
    );
  });

  it('blocks ambiguous/missing targets and invalid duplicate or UUID criteria', async () => {
    await expect(
      resolveRecordTarget(setup([{ Id: A }, { Id: B }]), 'Contact', {
        match_by: [{ field: 'Name', value: 'Acme' }],
      })
    ).rejects.toThrow();
    await expect(
      resolveRecordTarget(setup([]), 'Contact', { match_by: [{ field: 'Name', value: 'Acme' }] })
    ).rejects.toThrow();
    await expect(
      resolveRecordTarget(setup([]), 'Contact', {
        match_by: [
          { field: 'Name', value: 'A' },
          { field: 'Name', value: 'B' },
        ],
      })
    ).rejects.toThrow();
    await expect(
      resolveRecordTarget(setup([]), 'Contact', { match_by: [{ field: 'Id', value: A }] })
    ).rejects.toThrow();
  });

  it('resolves lookup business-key values by exact lookup only', async () => {
    const services = setup([{ Id: A, Name: 'Acme', AccountId: A }]);
    await resolveRecordTarget(services, 'Contact', { match_by: [{ field: 'AccountId', value: 'Acme' }] });
    expect(services.lookupResolver.resolve).toHaveBeenCalledWith('Account', 'Acme', 'Name', { fuzzy: false });
    expect(services.odataClient.getRecords).toHaveBeenCalledWith(
      'Contact',
      expect.objectContaining({ $filter: `(AccountId eq ${A})` }),
      true,
      2
    );
  });
});
