import { describe, expect, it } from 'vitest';
import { compileFilter, type Criterion } from '../../src/utils/filter-compiler.js';
import type { MetadataManager } from '../../src/metadata/metadata-manager.js';
import type { EntityMetadata, EntityProperty } from '../../src/types/index.js';

/** Поле: 'bool' — логический флаг, строка — lookup на эту коллекцию, 'text' — строка. */
type Schema = Record<string, Record<string, string>>;

const SCHEMA: Schema = {
  Opportunity: { Name: 'text', StageId: 'OpportunityStage', OwnerId: 'Contact' },
  OpportunityStage: { Name: 'text', End: 'bool', Successful: 'bool' },
  Case: { Number: 'text', StatusId: 'CaseStatus' },
  CaseStatus: { Name: 'text', IsFinal: 'bool', IsResolved: 'bool', IsPaused: 'bool' },
  Lead: { LeadName: 'text', QualifyStatusId: 'QualifyStatus', StatusId: 'LeadStatus' },
  QualifyStatus: { Name: 'text', IsFinal: 'bool', Successful: 'bool' },
  LeadStatus: { Name: 'text', Active: 'bool' },
  Invoice: { Number: 'text', PaymentStatusId: 'InvoicePaymentStatus', DeliveryStatusId: 'DeliveryStatus' },
  InvoicePaymentStatus: { Name: 'text', FinalStatus: 'bool' },
  DeliveryStatus: { Name: 'text', IsFinal: 'bool' },
  Contact: { Name: 'text', TypeId: 'ContactType' },
  ContactType: { Name: 'text' },
};

function meta(collection: string): EntityMetadata {
  const def = SCHEMA[collection];
  if (!def) throw new Error(`stub: unknown collection ${collection}`);
  const properties: EntityProperty[] = Object.entries(def).map(([name, kind]) => {
    const isLookup = kind !== 'bool' && kind !== 'text';
    return {
      name,
      type: kind === 'bool' ? 'Edm.Boolean' : isLookup ? 'Edm.Guid' : 'Edm.String',
      nullable: true,
      isLookup,
      lookupCollection: isLookup ? kind : undefined,
    };
  });
  return {
    name: collection,
    collectionName: collection,
    properties,
    lookupFields: properties.filter((p) => p.isLookup).map((p) => p.name),
    cachedAt: 0,
  };
}

const META = {
  async getEntityMetadata(collection: string) {
    return meta(collection);
  },
  async getLookupInfo(collection: string, field: string) {
    const prop = meta(collection).properties.find((p) => p.name === field);
    return prop?.isLookup
      ? { lookupCollection: prop.lookupCollection as string, displayColumn: 'Name' }
      : null;
  },
  async resolveFieldReference(collection: string, query: string) {
    const props = meta(collection).properties;
    const hit = props.find((p) => p.name === query || p.name === `${query}Id`);
    return hit ? { name: hit.name } : { name: null, suggestions: [] };
  },
} as unknown as MetadataManager;

function compile(collection: string, criteria: Criterion[]) {
  return compileFilter(criteria, { collection, metadataManager: META, odataVersion: 4 });
}

describe('state operators', () => {
  it('Opportunity: открыт/закрыт/выиграна/проиграна через Stage/End и Stage/Successful', async () => {
    const f = async (op: string) => (await compile('Opportunity', [{ field: 'Stage', op }])).filter;
    expect(await f('открытые')).toBe('(Stage eq null or Stage/End eq false)');
    expect(await f('закрыта')).toBe('Stage/End eq true');
    expect(await f('won')).toBe('(Stage/End eq true and Stage/Successful eq true)');
    expect(await f('проиграна')).toBe('(Stage/End eq true and Stage/Successful eq false)');
  });

  it('пишет заметку о том, что использовано, и резолвит StageId', async () => {
    const r = await compile('Opportunity', [{ field: 'StageId', op: 'открыт' }]);
    expect(r.warnings[0]).toContain('«открыт» → (Stage eq null or Stage/End eq false)');
    expect(r.used_fields[0].resolved).toBe('Stage');
  });

  it('Case: IsFinal + IsResolved, поле определяется само', async () => {
    const r = await compile('Case', [{ field: 'состояние', op: 'закрытые' }]);
    expect(r.filter).toBe('Status/IsFinal eq true');
    const won = await compile('Case', [{ op: 'успешно' } as Criterion]);
    expect(won.filter).toBe('(Status/IsFinal eq true and Status/IsResolved eq true)');
  });

  it('Lead: автоопределение выбирает QualifyStatus', async () => {
    const r = await compile('Lead', [{ field: 'state', op: 'open' }]);
    expect(r.filter).toBe('(QualifyStatus eq null or QualifyStatus/IsFinal eq false)');
  });

  it('LeadStatus: обратный признак Active', async () => {
    expect((await compile('Lead', [{ field: 'Status', op: 'закрыт' }])).filter).toBe(
      'Status/Active eq false'
    );
    expect((await compile('Lead', [{ field: 'Status', op: 'открыт' }])).filter).toBe(
      '(Status eq null or Status/Active eq true)'
    );
    await expect(compile('Lead', [{ field: 'Status', op: 'выиграна' }])).rejects.toThrow(/признака успеха/);
  });

  it('справочник без признаков — понятная ошибка', async () => {
    await expect(compile('Contact', [{ field: 'Type', op: 'закрыт' }])).rejects.toThrow(
      /ContactType.*End, FinalStatus, IsFinal, Finish или Active.*по названию статуса/
    );
  });

  it('несколько кандидатов при автоопределении — ошибка со списком', async () => {
    await expect(compile('Invoice', [{ field: '', op: 'закрыт' }])).rejects.toThrow(
      /несколько полей состояния: PaymentStatusId, DeliveryStatusId/
    );
  });

  it('сочетается с обычными критериями', async () => {
    const r = await compile('Opportunity', [
      { field: 'Stage', op: 'закрыт' },
      { field: 'Name', op: 'равно', value: 'X' },
    ]);
    expect(r.filter).toBe("(Stage/End eq true) and (Name eq 'X')");
  });
});
