/**
 * Строки заказа/счёта: сервер сам заполняет поля из продукта, считает суммы строки
 * и пересчитывает сумму родителя (OData не запускает расчёты страницы BPMSoft).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { HttpClient } from '../../src/client/http-client.js';
import { ODataClient } from '../../src/client/odata-client.js';
import { LookupResolver } from '../../src/lookup/lookup-resolver.js';
import { buildConfig } from '../../src/config.js';
import { registerBatchTools } from '../../src/tools/batch-tools.js';
import { resetServerCapabilities } from '../../src/utils/server-capabilities.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { EntityMetadata, EntityProperty } from '../../src/types/index.js';
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

const DECIMAL_FIELDS = [
  'Price',
  'Quantity',
  'CurrencyRate',
  'DiscountPercent',
  'DiscountAmount',
  'Amount',
  'TotalAmount',
  'TaxAmount',
  'PrimaryPrice',
  'PrimaryAmount',
  'PrimaryDiscountAmount',
  'PrimaryTaxAmount',
  'PrimaryTotalAmount',
  'AmountWithoutTax',
  'PrimaryAmountWithoutTax',
];
function entityMetadata(collection: string): EntityMetadata {
  const properties: EntityProperty[] = [
    ...DECIMAL_FIELDS.map((name) => ({ name, type: 'Edm.Decimal', nullable: true, isLookup: false })),
    ...['Id', 'ProductId', 'OrderId', 'InvoiceId', 'OpportunityId', 'PriceListId', 'UnitId', 'TaxId'].map(
      (name) => ({ name, type: 'Edm.Guid', nullable: true, isLookup: name !== 'Id' })
    ),
    ...['Name', 'Number'].map((name) => ({ name, type: 'Edm.String', nullable: true, isLookup: false })),
  ];
  return {
    name: collection,
    collectionName: collection,
    properties,
    lookupFields: properties.filter((p) => p.isLookup).map((p) => p.name),
    cachedAt: Date.now(),
  };
}
function metadataStub() {
  return {
    getEntityMetadata: async (collection: string) => entityMetadata(collection),
    resolveCollectionReference: async (collection: string) => ({ name: collection }),
    resolveFieldReference: async (collection: string, field: string) => ({
      name: entityMetadata(collection).properties.some((p) => p.name === field) ? field : null,
      suggestions: [],
    }),
    getLookupInfo: async () => null,
  };
}

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
  const services = {
    config: { odata_version: 4 },
    odataClient,
    metadataManager: metadataStub(),
  } as unknown as ServiceContainer;
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
      Price: '150',
      Amount: '300',
      DiscountAmount: '0',
      TotalAmount: '300',
      TaxAmount: '50',
      PrimaryAmount: '300',
      PrimaryTotalAmount: '300',
    });
    expect(r.notes).toContain('Цена из прайс-листа: 150');
    expect(r.parents).toEqual([ORDER]);
    expect(calls.lists[0].query.$filter).toBe(`Product/Id eq ${PRODUCT} and PriceList/Id eq ${PRICE_LIST}`);
  });

  it('falls back to Product.Price and defaults quantity to 1', async () => {
    const { services } = setup();
    const r = await enrichLineItem(services, 'OrderProduct', { OrderId: ORDER, ProductId: PRODUCT });
    expect(r.data).toMatchObject({ Price: '100', Quantity: '1', Amount: '100' });
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
      Price: '200',
      Amount: '600',
      DiscountAmount: '60',
      TotalAmount: '540',
      TaxAmount: '90',
    });
    expect(calls.lists).toHaveLength(0);
    expect(r.notes.some((n) => n.includes('Amount: передано 1'))).toBe(true);
  });

  it.each([
    ['123.45', '370.35', '37.04', '333.31', '55.55'],
    ['-123.45', '-370.35', '-37.04', '-333.31', '-55.55'],
  ])('rounds a half-cent discount correctly for price %s', async (price, amount, discount, total, tax) => {
    const { services } = setup();
    const r = await enrichLineItem(services, 'OrderProduct', {
      ProductId: PRODUCT,
      Price: price,
      Quantity: '3',
      DiscountPercent: '10',
    });
    expect(r.data).toMatchObject({
      Amount: amount,
      DiscountAmount: discount,
      TotalAmount: total,
      TaxAmount: tax,
      PrimaryAmount: amount,
      PrimaryDiscountAmount: discount,
      PrimaryTotalAmount: total,
    });
  });

  it.each([
    ['1.005', '1.01'],
    ['-1.005', '-1.01'],
  ])('rounds the line amount and primary price half-up for price %s', async (price, amount) => {
    const { services } = setup();
    const r = await enrichLineItem(services, 'OrderProduct', { Price: price, Quantity: '1' });
    expect(r.data).toMatchObject({
      Price: price,
      Amount: amount,
      TotalAmount: amount,
      PrimaryPrice: amount,
      DiscountAmount: '0',
      TaxAmount: '0',
    });
    expect(r.notes.some((note) => note.startsWith('Скидка:') || note.startsWith('Налог'))).toBe(false);
  });

  it('keeps large Decimal prices, discount and included tax exact', async () => {
    const { services } = setup();
    const r = await enrichLineItem(services, 'InvoiceProduct', {
      ProductId: PRODUCT,
      Price: '9007199254740993.01',
      Quantity: '3',
      DiscountPercent: '10',
      PrimaryAmount: '42.5',
    });
    expect(r.data).toMatchObject({
      Price: '9007199254740993.01',
      Amount: '27021597764222979.03',
      DiscountAmount: '2702159776422297.9',
      TotalAmount: '24319437987800681.13',
      TaxAmount: '4053239664633446.86',
      PrimaryAmount: '42.5',
      PrimaryTotalAmount: '24319437987800681.13',
    });
  });

  it('preserves supplied primary fields and leaves them ungenerated at another currency rate', async () => {
    const { services } = setup();
    const r = await enrichLineItem(services, 'OrderProduct', {
      Price: '1.25',
      Quantity: '2',
      CurrencyRate: '1.5',
      PrimaryAmount: '4',
      Amount: '2.5000',
    });
    expect(r.data).toMatchObject({ Amount: '2.5', PrimaryAmount: '4' });
    expect(r.data).not.toHaveProperty('PrimaryPrice');
    expect(r.notes.some((note) => note.startsWith('Amount: передано'))).toBe(false);
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
    expect(r.data).toMatchObject({ Quantity: '4', Amount: '600', TotalAmount: '600', TaxAmount: '100' });
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
    expect(r.data).toEqual({ ProductId: PRODUCT, Quantity: '3', Price: '100', Amount: '300' });
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
      { collection: 'Order', id: ORDER, data: { Amount: '420.5', PrimaryAmount: '420.5' } },
    ]);
    expect(notes).toEqual(['Сумма заказа ORD-2 пересчитана: 420.5']);
  });

  it('a failed recalculation becomes a warning, not an error', async () => {
    const { services } = setup({ failPatch: true });
    const notes = await recalcParentTotals(services, 'OrderProduct', [ORDER]);
    expect(notes[0]).toMatch(/^Предупреждение: .*HTTP 500/);
  });

  it('sums large invoice amounts and subtracts tax without binary precision loss', async () => {
    const { services, calls } = setup({
      records: { [`Invoice:${ORDER}`]: { Number: 'INV-3', CurrencyRate: '1.000' } },
      lines: [
        { TotalAmount: '9007199254740993.01', TaxAmount: '1501199875790165.5' },
        { TotalAmount: '0.09', TaxAmount: '0.01' },
      ],
    });
    const notes = await recalcParentTotals(services, 'InvoiceProduct', [ORDER]);
    expect(notes).toEqual(['Сумма счёта INV-3 пересчитана: 9007199254740993.1']);
    expect(calls.patches[0].data).toEqual({
      Amount: '9007199254740993.1',
      PrimaryAmount: '9007199254740993.1',
      AmountWithoutTax: '7505999378950827.59',
      PrimaryAmountWithoutTax: '7505999378950827.59',
    });
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
      metadataManager: metadataStub(),
      lookupResolver: { resolveDataLookups: async (_c: string, data: Row) => ({ data, notes: [] }) },
    });
    (s.odataClient as Record<string, unknown>).createRecordWithOutcome = async (_c: string, data: Row) => {
      posted.push(data);
      return { record: { Id: LINE, ...data }, created: true };
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
    expect(posted[0]).toMatchObject({ Amount: '300', TotalAmount: '300', TaxAmount: '50', Name: 'Молоко' });
    expect(r.content[0].text).toMatch(/Расчёт строк: .*Сумма: 300.*Предупреждение/);
  });
});

interface WireCall {
  method: string;
  url: string;
  body?: Row;
  headers: Headers;
  batch?: boolean;
}
function wireSetup(mode: 'batch' | 'single' = 'batch') {
  resetServerCapabilities();
  const config = {
    ...buildConfig('https://crm.example.test'),
    odata_version: 4 as const,
    platform: 'net8' as const,
  };
  const http = new HttpClient(config);
  http.setAllowEnvCreds(true);
  http.updateAuthState({ isAuthenticated: true, csrfToken: 'test-token' });
  const client = new ODataClient(config, http);
  const metadataManager = metadataStub();
  const stored = new Map<string, Row>([
    [
      `Product:${PRODUCT}`,
      { Id: PRODUCT, Name: 'Fixture product', Price: '123.45', UnitId: UNIT, TaxId: TAX },
    ],
    [`Tax:${TAX}`, { Id: TAX, Percent: '20' }],
    [`Order:${ORDER}`, { Id: ORDER, Number: 'Fixture order', CurrencyRate: '1', Amount: '0' }],
    [`Invoice:${ORDER}`, { Id: ORDER, Number: 'Fixture invoice', CurrencyRate: '1', Amount: '0' }],
    [`InvoiceProduct:${LINE}`, { Id: LINE, InvoiceId: ORDER, TotalAmount: '270', TaxAmount: '45' }],
  ]);
  const calls: WireCall[] = [];
  const simulate = (method: string, address: string, body?: Row): { status: number; body: unknown } => {
    const url = new URL(address, 'https://crm.example.test');
    const path = url.pathname.split('/').pop()!;
    const match = /^([A-Za-z]+)\(([^)]+)\)$/.exec(path);
    const collection = match?.[1] ?? path;
    const id = match?.[2];
    if (method === 'GET') {
      if (id) {
        const record = stored.get(`${collection}:${id}`);
        return record
          ? { status: 200, body: { ...record } }
          : { status: 404, body: { error: { message: 'Not found' } } };
      }
      return {
        status: 200,
        body: {
          value: [...stored.entries()]
            .filter(([key]) => key.startsWith(`${collection}:`))
            .map(([, record]) => ({ ...record })),
        },
      };
    }
    const values = Object.fromEntries(
      Object.entries(body ?? {}).map(([field, value]) => [
        field,
        DECIMAL_FIELDS.includes(field) ? String(value) : value,
      ])
    );
    if (method === 'POST') {
      const key = `${collection}:${String(values.Id)}`;
      stored.set(key, values);
      return { status: 201, body: { ...values } };
    }
    if (method === 'PATCH') {
      const key = `${collection}:${id}`;
      stored.set(key, { ...stored.get(key), ...values });
      return { status: 200, body: { ...stored.get(key) } };
    }
    return { status: 405, body: { error: { message: 'Unexpected method' } } };
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (address: string, request: RequestInit) => {
      const headers = new Headers(request.headers);
      const method = request.method ?? 'GET';
      const body = request.body === undefined ? undefined : (JSON.parse(String(request.body)) as Row);
      if (new URL(address).pathname.endsWith('/$batch')) {
        const requests = body?.requests as Array<{
          id: string;
          method: string;
          url: string;
          body?: Row;
          headers: Record<string, string>;
        }>;
        if (mode === 'single')
          return Response.json({
            responses: requests.map((inner) => ({
              id: inner.id,
              status: 400,
              body: { error: { message: 'Batch unsupported' } },
            })),
          });
        return Response.json({
          responses: requests.map((inner) => {
            if (inner.method !== 'GET') {
              const innerHeaders = new Headers(inner.headers);
              expect(innerHeaders.get('Content-Type')).not.toContain('IEEE754Compatible');
              for (const [field, value] of Object.entries(inner.body ?? {}))
                if (DECIMAL_FIELDS.includes(field)) expect(typeof value, field).toBe('number');
              calls.push({
                method: inner.method,
                url: inner.url,
                body: inner.body,
                headers: innerHeaders,
                batch: true,
              });
            }
            const result = simulate(inner.method, inner.url, inner.body);
            return { id: inner.id, status: result.status, body: result.body };
          }),
        });
      }
      if (method === 'POST' || method === 'PATCH') {
        expect(headers.get('Content-Type')).toContain('IEEE754Compatible=true');
        for (const [field, value] of Object.entries(body ?? {}))
          if (DECIMAL_FIELDS.includes(field))
            expect(typeof value, `${method} ${address} ${field}`).toBe('string');
        calls.push({ method, url: address, body, headers });
      }
      const result = simulate(method, address, body);
      return Response.json(result.body, { status: result.status });
    })
  );
  const services = {
    initialized: true,
    config,
    authManager: { ensureAuthenticated: async () => undefined },
    metadataManager,
    odataClient: client,
    lookupResolver: new LookupResolver(config, client, metadataManager as never),
  } as unknown as ServiceContainer;
  const handlers = new Map<string, (args: Row) => Promise<CallToolResult>>();
  const server = {
    registerTool: (name: string, _metadata: unknown, handler: (args: Row) => Promise<CallToolResult>) =>
      handlers.set(name, handler),
  };
  registerWriteTools(server as never, services);
  registerBatchTools(server as never, services);
  const call = (name: string, args: Row) => handlers.get(name)!(args);
  const confirm = async (name: string, args: Row) => {
    const preview = await call(name, args);
    expect(preview.isError).toBeFalsy();
    return call(name, {
      ...args,
      confirm: true,
      confirmation_token: preview.structuredContent?.confirmation_token,
    });
  };
  return { services, stored, calls, call, confirm };
}
afterEach(() => vi.unstubAllGlobals());

describe('generated line values through actual HTTP serialization', () => {
  it('writes typed Decimal strings after calculation in single create, update, bulk update and parent totals', async () => {
    const env = wireSetup();
    const created = await env.call('bpm_create_record', {
      collection: 'OrderProduct',
      data: { OrderId: ORDER, ProductId: PRODUCT, Quantity: '2', CurrencyRate: '1', DiscountPercent: '10' },
      idempotency_key: 'fixture-order-line',
    });
    expect(created.isError).toBeFalsy();
    const record = created.structuredContent?.record as Row;
    const id = String(record.Id);
    const first = env.calls.find((call) => call.method === 'POST' && call.url.includes('/OrderProduct'))!;
    expect(first.body).toMatchObject({
      Price: '123.45',
      Quantity: '2',
      Amount: '246.9',
      DiscountAmount: '24.69',
      TotalAmount: '222.21',
      PrimaryTotalAmount: '222.21',
    });
    expect(env.stored.get(`Order:${ORDER}`)).toMatchObject({ Amount: '222.21', PrimaryAmount: '222.21' });
    expect(
      (await env.call('bpm_update_record', { collection: 'OrderProduct', id, data: { Quantity: '3' } }))
        .isError
    ).toBeFalsy();
    expect(env.stored.get(`OrderProduct:${id}`)).toMatchObject({
      Quantity: '3',
      Amount: '370.35',
      DiscountAmount: '37.04',
      TotalAmount: '333.31',
      TaxAmount: '55.55',
    });
    expect(env.stored.get(`Order:${ORDER}`)?.Amount).toBe('333.31');
    expect(
      (
        await env.confirm('bpm_update_by_filter', {
          collection: 'OrderProduct',
          filter: `Id eq ${id}`,
          expected_count: 1,
          data: { Quantity: '4' },
        })
      ).isError
    ).toBe(false);
    expect(env.stored.get(`OrderProduct:${id}`)).toMatchObject({ Quantity: '4', TotalAmount: '444.42' });
    expect(env.stored.get(`Order:${ORDER}`)).toMatchObject({ Amount: '444.42', PrimaryAmount: '444.42' });
    expect(
      env.calls.filter((call) => call.url.includes('/OrderProduct') && call.method === 'PATCH')
    ).toHaveLength(2);
  });
  it.each(['batch', 'single'] as const)(
    'preserves generated EDM values for batch create/update executed in %s mode',
    async (mode) => {
      const env = wireSetup(mode);
      const created = await env.call('bpm_batch_create', {
        collection: 'OrderProduct',
        records: [
          { OrderId: ORDER, ProductId: PRODUCT, Quantity: '2', CurrencyRate: '1', DiscountPercent: '10' },
        ],
        idempotency_key: `fixture-line-${mode}`,
      });
      expect(created.isError).toBe(false);
      expect(created.structuredContent?.mode).toBe(mode);
      const id = (created.structuredContent?.created as string[])[0];
      expect(env.stored.get(`OrderProduct:${id}`)).toMatchObject({
        Price: '123.45',
        Amount: '246.9',
        TotalAmount: '222.21',
      });
      expect(env.stored.get(`Order:${ORDER}`)?.Amount).toBe('222.21');
      const updated = await env.confirm('bpm_batch_update', {
        collection: 'OrderProduct',
        updates: [{ id, data: { Quantity: '3' } }],
      });
      expect(updated.isError).toBe(false);
      expect(updated.structuredContent?.mode).toBe(mode);
      expect(env.stored.get(`OrderProduct:${id}`)).toMatchObject({
        Amount: '370.35',
        DiscountAmount: '37.04',
        TotalAmount: '333.31',
        TaxAmount: '55.55',
      });
      expect(env.stored.get(`Order:${ORDER}`)?.Amount).toBe('333.31');
      expect(
        env.calls
          .filter((call) => call.url.includes('/OrderProduct'))
          .every((call) => Boolean(call.batch) === (mode === 'batch'))
      ).toBe(true);
    }
  );
  it('normalizes Invoice amounts without tax and primary sums before the parent PATCH', async () => {
    const env = wireSetup();
    const notes = await recalcParentTotals(env.services, 'InvoiceProduct', [ORDER]);
    expect(notes).toEqual(['Сумма счёта Fixture invoice пересчитана: 270']);
    expect(env.stored.get(`Invoice:${ORDER}`)).toMatchObject({
      Amount: '270',
      PrimaryAmount: '270',
      AmountWithoutTax: '225',
      PrimaryAmountWithoutTax: '225',
    });
  });
});
