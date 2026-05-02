import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compileFilter, type Criterion } from '../../src/utils/filter-compiler.js';
import { UnknownFieldError } from '../../src/utils/errors.js';
import type { MetadataManager } from '../../src/metadata/metadata-manager.js';
import type { EntityMetadata, EntityProperty } from '../../src/types/index.js';

// ============================================================
// MetadataManager stub
// ============================================================

interface CollectionDef {
  /** OData identifier names. Each maps to optional caption + lookup target. */
  fields: Record<
    string,
    {
      caption?: string;
      type?: string;
      isLookup?: boolean;
      lookupCollection?: string;
      displayColumn?: string;
    }
  >;
}

function makeStubMetadata(collections: Record<string, CollectionDef>): MetadataManager {
  const buildMeta = (collection: string): EntityMetadata => {
    const def = collections[collection];
    if (!def) {
      throw new Error(`stub: unknown collection ${collection}`);
    }
    const props: EntityProperty[] = Object.entries(def.fields).map(([name, info]) => ({
      name,
      type: info.type ?? 'Edm.String',
      nullable: true,
      isLookup: !!info.isLookup,
      lookupCollection: info.lookupCollection,
      lookupDisplayColumn: info.displayColumn ?? 'Name',
      caption: info.caption,
    }));
    return {
      name: collection,
      collectionName: collection,
      properties: props,
      lookupFields: props.filter((p) => p.isLookup).map((p) => p.name),
      cachedAt: Date.now(),
    };
  };

  const stub: Partial<MetadataManager> = {
    async getEntityMetadata(collection: string) {
      return buildMeta(collection);
    },
    async getLookupInfo(collection: string, fieldName: string) {
      const meta = buildMeta(collection);
      const prop = meta.properties.find((p) => p.name === fieldName);
      if (!prop?.isLookup || !prop.lookupCollection) return null;
      return {
        lookupCollection: prop.lookupCollection,
        displayColumn: prop.lookupDisplayColumn || 'Name',
      };
    },
    async resolveFieldReference(collection: string, query: string) {
      const meta = buildMeta(collection);
      // exact name
      const exact = meta.properties.find((p) => p.name === query);
      if (exact) return { name: exact.name };
      // case-insensitive name
      const ci = meta.properties.find((p) => p.name.toLowerCase() === query.toLowerCase());
      if (ci) return { name: ci.name };
      // caption match
      const cap = meta.properties.find(
        (p) => p.caption && p.caption.toLowerCase() === query.toLowerCase()
      );
      if (cap) return { name: cap.name };
      // v4: try query + 'Id' for lookup convenience
      if (!query.endsWith('Id')) {
        const withId = meta.properties.find((p) => p.name === `${query}Id`);
        if (withId) return { name: withId.name };
      }
      return { name: null, suggestions: meta.properties.map((p) => p.name).slice(0, 3) };
    },
  };
  return stub as MetadataManager;
}

// Two collections — Contact has CityId lookup → City.
const META = makeStubMetadata({
  Contact: {
    fields: {
      Id: { type: 'Edm.Guid', caption: 'Идентификатор' },
      Name: { caption: 'ФИО' },
      Description: { caption: 'Описание' },
      Age: { type: 'Edm.Int32', caption: 'Возраст' },
      IsVip: { type: 'Edm.Boolean', caption: 'VIP' },
      CreatedOn: { type: 'Edm.DateTimeOffset', caption: 'Дата создания' },
      CityId: {
        type: 'Edm.Guid',
        caption: 'Город',
        isLookup: true,
        lookupCollection: 'City',
        displayColumn: 'Name',
      },
      Account: {
        type: 'Edm.Guid',
        caption: 'Контрагент',
        isLookup: true,
        lookupCollection: 'Account',
      },
    },
  },
  City: {
    fields: {
      Id: { type: 'Edm.Guid' },
      Name: { caption: 'Название' },
    },
  },
  Account: {
    fields: {
      Id: { type: 'Edm.Guid' },
      Name: { caption: 'Название' },
      CityId: {
        type: 'Edm.Guid',
        caption: 'Город',
        isLookup: true,
        lookupCollection: 'City',
        displayColumn: 'Name',
      },
    },
  },
});

function compile(criteria: Criterion[], opts: { join?: 'and' | 'or'; v?: 3 | 4 } = {}) {
  return compileFilter(criteria, {
    collection: 'Contact',
    metadataManager: META,
    odataVersion: opts.v ?? 4,
    join: opts.join,
  });
}

// ============================================================
// Tests
// ============================================================

describe('compileFilter — primitives', () => {
  it('equals with a string value', async () => {
    const r = await compile([{ field: 'Name', op: 'равно', value: 'Иванов' }]);
    expect(r.filter).toBe("Name eq 'Иванов'");
    expect(r.used_fields).toEqual([
      { input: 'Name', resolved: 'Name', caption: 'ФИО' },
    ]);
    expect(r.warnings).toEqual([]);
  });

  it('equals with a numeric value (no quotes)', async () => {
    const r = await compile([{ field: 'Age', op: 'eq', value: 25 }]);
    expect(r.filter).toBe('Age eq 25');
  });

  it('equals with a boolean value', async () => {
    const r = await compile([{ field: 'IsVip', op: 'eq', value: true }]);
    expect(r.filter).toBe('IsVip eq true');
  });

  it('contains escapes single quotes inside the value', async () => {
    const r = await compile([{ field: 'Name', op: 'содержит', value: "O'Brien" }]);
    expect(r.filter).toBe("contains(Name, 'O''Brien')");
  });
});

describe('compileFilter — collections of values', () => {
  it('in produces a parenthesized chain of "or eq"', async () => {
    const r = await compile([
      { field: 'Name', op: 'в списке', value: ['Иванов', 'Петров', 'Сидоров'] },
    ]);
    expect(r.filter).toBe("(Name eq 'Иванов' or Name eq 'Петров' or Name eq 'Сидоров')");
  });

  it('between with date strings yields ge/le pair', async () => {
    const r = await compile([
      {
        field: 'CreatedOn',
        op: 'между',
        value: '2026-01-01T00:00:00Z',
        value_to: '2026-04-30T23:59:59Z',
      },
    ]);
    expect(r.filter).toBe(
      'CreatedOn ge 2026-01-01T00:00:00Z and CreatedOn le 2026-04-30T23:59:59Z'
    );
  });
});

describe('compileFilter — null checks', () => {
  it('is_null and is_not_null', async () => {
    const a = await compile([{ field: 'Description', op: 'пусто' }]);
    expect(a.filter).toBe('Description eq null');
    const b = await compile([{ field: 'Description', op: 'не пусто' }]);
    expect(b.filter).toBe('Description ne null');
  });
});

describe('compileFilter — relative time windows', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Pin "now" to 2026-05-02T12:00:00Z (matches CLAUDE.md current date).
    vi.setSystemTime(new Date('2026-05-02T12:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('in_last_days computes a stable lower bound', async () => {
    const r = await compile([{ field: 'CreatedOn', op: 'за последние 7 дней', value: 7 }]);
    expect(r.filter).toBe('CreatedOn ge 2026-04-25T12:00:00Z');
  });
});

describe('compileFilter — navigation and captions', () => {
  it('Account.City navigation becomes Account/CityId in the path', async () => {
    const r = await compile([
      {
        field: 'Account.City',
        op: 'eq',
        value: '11111111-1111-1111-1111-111111111111',
      },
    ]);
    // Navigation property name in v4 is "Account" (the FK is AccountId, but
    // the metadata stub exposes "Account" directly as a lookup field). The
    // last segment is the resolved CityId.
    expect(r.filter).toBe(
      "Account/CityId eq 11111111-1111-1111-1111-111111111111"
    );
  });

  it('resolves a Russian caption to the OData field name', async () => {
    const r = await compile([{ field: 'Возраст', op: 'gt', value: 18 }]);
    expect(r.filter).toBe('Age gt 18');
    expect(r.used_fields[0]).toEqual({ input: 'Возраст', resolved: 'Age', caption: 'Возраст' });
  });
});

describe('compileFilter — error handling', () => {
  it('throws UnknownFieldError with suggestions for unknown field', async () => {
    await expect(
      compile([{ field: 'Несуществующее', op: 'eq', value: 'x' }])
    ).rejects.toBeInstanceOf(UnknownFieldError);
  });
});

describe('compileFilter — lookup values', () => {
  it('GUID for a lookup field on OData v3 wraps in guid"..."', async () => {
    const r = await compile(
      [{ field: 'CityId', op: 'eq', value: '22222222-2222-2222-2222-222222222222' }],
      { v: 3 }
    );
    expect(r.filter).toBe("CityId eq guid'22222222-2222-2222-2222-222222222222'");
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toContain('lookup');
  });
});

describe('compileFilter — joining', () => {
  it('default join is "and"', async () => {
    const r = await compile([
      { field: 'Name', op: 'eq', value: 'Иванов' },
      { field: 'Age', op: 'gt', value: 18 },
    ]);
    expect(r.filter).toBe("(Name eq 'Иванов') and (Age gt 18)");
  });

  it('join="or" joins with " or "', async () => {
    const r = await compile(
      [
        { field: 'Name', op: 'eq', value: 'Иванов' },
        { field: 'Name', op: 'eq', value: 'Петров' },
      ],
      { join: 'or' }
    );
    expect(r.filter).toBe("(Name eq 'Иванов') or (Name eq 'Петров')");
  });
});
