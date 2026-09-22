/**
 * Строки заказа/счёта: сервер сам заполняет поля из продукта, считает суммы строки
 * и пересчитывает сумму родителя (OData не запускает расчёты страницы BPMSoft).
 */

import { describe, it, expect } from 'vitest';
import { enrichLineItem, lineParentIds, recalcParentTotals } from '../../src/workflows/line-items.js';
import { registerWriteTools } from '../../src/tools/write-tools.js';
import type { ServiceContainer } from '../../src/tools/init-tool.js';

type Row = Record<string, unknown>;

const ORDER = 'aaaaaaaa-0000-0000-0000-000000000001';
const PRODUCT = 'bbbbbbbb-0000-0000-0000-000000000001';
const PRICE_LIST = 'cccccccc-0000-0000-0000-000000000001';
const TAX = 'dddddddd-0000-0000-0000-000000000001';
const UNIT = 'eeeeeeee-0000-0000-0000-000000000001';
const LINE = 'ffffffff-0000-0000-0000-000000000001';

interface Calls {
  gets: Array<{ collection: string; query?: Row }>;
  lists: Array<{ collection: string; query: Row }>;
  patches: Array<{ collection: string; id: string; data: Row }>;
}

function setup(
  opts: {
    listPrice?: number;
    records?: Record<string, Row>;
    lines?: Row[];
    failPatch?: boolean;
  } = {}
): { services: ServiceContainer; calls: Calls } {
  const calls: Calls = { gets: [], lists: [], patches: [] };
  const records: Record<string, Row> = {
    [`Product:${PRODUCT}`]: { Name: 'Молоко', Price: 100, UnitId: UNIT, TaxId: TAX },
    [`Tax:${TAX}`]: { Percent: 20 },
    [`Order:${ORDER}`]: { Number: 'ORD-2', CurrencyRate: 1 },
    ...opts.records,
  };
  const odataClient = {
    async getRecord(collection: string, id: string, query?: Row) {
      calls.gets.push({ collection, query });
      const r = records[`${collection}:${id}`];
      if (!r) throw new Error(`нет ${collection}(${id})`);
      return r;
    },
    async getRecords(collection: string, query: Row) {
      calls.lists.push({ collection, query });
      if (collection === 'ProductPrice') {
        return { value: opts.listPrice === undefined ? [] : [{ Price: opts.listPrice }] };
      }
      if (String(query.$filter).startsWith('Id eq')) return { value: [{ Id: LINE, OrderId: ORDER }] };
      return { value: opts.lines ?? [] };
    },
    async updateRecord(collection: string, id: string, data: Row) {
      if (opts.failPatch && collection === 'Order') throw new Error('HTTP 500');
      calls.patches.push({ collection, id, data });
      return null;
    },
  };
  const services = { config: { odata_version: 4 }, odataClient } as unknown as ServiceContainer;
  return { services, calls };
}

describe('enrichLineItem', () => {
  it('takes the price from the line price list and fills name, unit and tax from the product', async () => {
    const { services, calls } = setup({ listPrice: 150 });
    const r = await enrichLineItem(services, 'OrderProduct', {
      OrderId: ORDER,
      ProductId: PRODUCT,
      PriceListId: PRICE_LIST,
      Quantity: 2,
    });
    expect(r.data).toMatchObject({
      Name: 'Молоко',
      UnitId: UNIT,
      TaxId: TAX,
      Price: 150,
      Amount: 300,
      DiscountAmount: 0,
      TotalAmount: 300,
      TaxAmount: 50,
      PrimaryAmount: 300,
      PrimaryTotalAmount: 300,
    });
    expect(r.notes).toContain('Цена из прайс-листа: 150');
    expect(r.parents).toEqual([ORDER]);
    expect(calls.lists[0].query.$filter).toBe(`Product/Id eq ${PRODUCT} and PriceList/Id eq ${PRICE_LIST}`);
  });

  it('falls back to Product.Price and defaults quantity to 1', async () => {
    const { services } = setup();
    const r = await enrichLineItem(services, 'OrderProduct', { OrderId: ORDER, ProductId: PRODUCT });
    expect(r.data).toMatchObject({ Price: 100, Quantity: 1, Amount: 100 });
    expect(r.notes).toContain('Цена из продукта: 100');
  });

  it('keeps an explicit price and name, applies discount percent, tax is included in the total', async () => {
    const { services, calls } = setup({ listPrice: 150 });
    const r = await enrichLineItem(services, 'OrderProduct', {
      OrderId: ORDER,
      ProductId: PRODUCT,
      PriceListId: PRICE_LIST,
      Name: 'Своё',
      Price: 200,
      Quantity: 3,
      DiscountPercent: 10,
      Amount: 1,
    });
    expect(r.data).toMatchObject({
      Name: 'Своё',
      Price: 200,
      Amount: 600,
      DiscountAmount: 60,
      TotalAmount: 540,
      TaxAmount: 90,
    });
    expect(calls.lists).toHaveLength(0);
    expect(r.notes.some((n) => n.includes('Amount: передано 1'))).toBe(true);
  });

  it('merges with the existing record on update and sends only changed fields', async () => {
    const existing = {
      OrderId: ORDER,
      ProductId: PRODUCT,
      Name: 'Молоко',
      Price: 150,
      Quantity: 2,
      TaxId: TAX,
    };
    const { services } = setup({ records: { [`OrderProduct:${LINE}`]: existing } });
    const r = await enrichLineItem(services, 'OrderProduct', { Quantity: 4 }, { id: LINE });
    expect(r.data).toMatchObject({ Quantity: 4, Amount: 600, TotalAmount: 600, TaxAmount: 100 });
    expect(r.data).not.toHaveProperty('Name');
    expect(r.data).not.toHaveProperty('Price');
    expect(r.parents).toEqual([ORDER]);
  });

  it('opportunity interest: only price default and amount', async () => {
    const { services } = setup();
    const r = await enrichLineItem(services, 'OpportunityProductInterest', {
      ProductId: PRODUCT,
      Quantity: 3,
    });
    expect(r.data).toEqual({ ProductId: PRODUCT, Quantity: 3, Price: 100, Amount: 300 });
    expect(r.parents).toEqual([]);
  });

  it('leaves non-line collections untouched without any request', async () => {
    const { services, calls } = setup();
    const data = { Name: 'Альфа' };
    const r = await enrichLineItem(services, 'Account', data);
    expect(r).toEqual({ data, notes: [], parents: [] });
    expect(calls.gets.length + calls.lists.length).toBe(0);
  });
});

describe('recalcParentTotals', () => {
  it('sums line totals via navigation filter and patches the order', async () => {
    const { services, calls } = setup({
      lines: [
        { TotalAmount: 300, TaxAmount: 50 },
        { TotalAmount: 120.5, TaxAmount: 0 },
      ],
    });
    const notes = await recalcParentTotals(services, 'OrderProduct', [ORDER, ORDER]);
    expect(calls.lists).toHaveLength(1);
    expect(calls.lists[0].query.$filter).toBe(`Order/Id eq ${ORDER}`);
    expect(calls.patches).toEqual([
      { collection: 'Order', id: ORDER, data: { Amount: 420.5, PrimaryAmount: 420.5 } },
    ]);
    expect(notes).toEqual(['Сумма заказа ORD-2 пересчитана: 420.5']);
  });

  it('a failed recalculation becomes a warning, not an error', async () => {
    const { services } = setup({ failPatch: true });
    const notes = await recalcParentTotals(services, 'OrderProduct', [ORDER]);
    expect(notes[0]).toMatch(/^Предупреждение: .*HTTP 500/);
  });

  it('reads parent ids of lines before deletion', async () => {
    const { services } = setup();
    expect(await lineParentIds(services, 'OrderProduct', [LINE])).toEqual([ORDER]);
    expect(await lineParentIds(services, 'Account', [LINE])).toEqual([]);
  });
});

describe('bpm_create_record on a line collection', () => {
  it('sends computed sums, recalculates the order and still succeeds when recalculation fails', async () => {
    const { services } = setup({ failPatch: true });
    const posted: Row[] = [];
    const s = services as unknown as Record<string, unknown>;
    Object.assign(s, {
      initialized: true,
      authManager: { ensureAuthenticated: async () => undefined },
      metadataManager: {
        resolveCollectionReference: async (c: string) => ({ name: c }),
        getEntityMetadata: async () => ({ properties: [{ name: 'Id' }, { name: 'Name' }] }),
      },
      lookupResolver: { resolveDataLookups: async (_c: string, data: Row) => ({ data, notes: [] }) },
    });
    (s.odataClient as Record<string, unknown>).createRecord = async (_c: string, data: Row) => {
      posted.push(data);
      return { Id: LINE, ...data };
    };
    const handlers = new Map<
      string,
      (a: Row) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>
    >();
    registerWriteTools(
      { registerTool: (n: string, _m: unknown, h: never) => handlers.set(n, h) } as never,
      services
    );
    const r = await handlers.get('bpm_create_record')!({
      collection: 'OrderProduct',
      data: { OrderId: ORDER, ProductId: PRODUCT, Quantity: 2, Price: 150 },
    });
    expect(r.isError).toBeFalsy();
    expect(posted[0]).toMatchObject({ Amount: 300, TotalAmount: 300, TaxAmount: 50, Name: 'Молоко' });
    expect(r.content[0].text).toMatch(/Расчёт строк: .*Сумма: 300.*Предупреждение/);
  });
});
