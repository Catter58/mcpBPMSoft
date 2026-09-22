/**
 * Строки заказа/счёта/продуктов возможности: запись через OData не запускает расчёты
 * страницы BPMSoft (тестовый стенд: Name пуст, Amount/TotalAmount/TaxAmount = 0, сумма
 * заказа не меняется). Сервер заполняет поля из продукта, считает суммы строки и
 * пересчитывает сумму родителя сам, чтобы агенту не приходилось делать это вручную.
 *
 * Обе функции не бросают: сбой расчёта превращается в предупреждение, запись идёт дальше.
 */

import type { ServiceContainer } from '../tools/init-tool.js';
import { guidLiteral, isGuid } from '../utils/odata.js';

interface LineConfig {
  parent: 'Order' | 'Invoice' | null;
  fk: string;
  full: boolean;
}

export const LINE_ITEMS: Record<string, LineConfig> = {
  OrderProduct: { parent: 'Order', fk: 'OrderId', full: true },
  InvoiceProduct: { parent: 'Invoice', fk: 'InvoiceId', full: true },
  OpportunityProductInterest: { parent: null, fk: 'OpportunityId', full: false },
};

const EMPTY_GUID = '00000000-0000-0000-0000-000000000000';
const PARENT_LABEL = { Order: 'заказа', Invoice: 'счёта' } as const;
/** Сколько Id сверяется одним GET (длина URL). */
const QUERY_CHUNK = 40;

type Row = Record<string, unknown>;

export interface LineItemResult {
  data: Row;
  notes: string[];
  /** Родители, чья сумма могла измениться (старый и новый при смене родителя). */
  parents: string[];
}

/** Конфигурация строки или null; v3-суффикс Collection отбрасывается. */
export function lineConfig(collection: string): LineConfig | null {
  return LINE_ITEMS[collection.replace(/Collection$/, '')] ?? null;
}

const r2 = (n: number): number => Math.round(n * 100) / 100;
const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
const isEmpty = (v: unknown): boolean => v === undefined || v === null || v === '' || v === EMPTY_GUID;
const errorOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const guidOf = (v: unknown): string | null =>
  typeof v === 'string' && isGuid(v) && v !== EMPTY_GUID ? v : null;

/**
 * Дополняет данные строки (уже с разрешёнными lookup, т. е. UUID). Для обновления
 * передайте `update.id` (запись будет прочитана) или сразу `update.record`.
 * Возвращает данные для отправки: переданные поля + заполненные + рассчитанные.
 */
export async function enrichLineItem(
  services: ServiceContainer,
  collection: string,
  data: Row,
  update?: { id: string; record?: Row }
): Promise<LineItemResult> {
  const cfg = lineConfig(collection);
  if (!cfg) return { data, notes: [], parents: [] };
  try {
    return await enrich(services, collection, cfg, data, update);
  } catch (error) {
    return { data, notes: [`Предупреждение: строку рассчитать не удалось (${errorOf(error)})`], parents: [] };
  }
}

async function enrich(
  services: ServiceContainer,
  collection: string,
  cfg: LineConfig,
  data: Row,
  update?: { id: string; record?: Row }
): Promise<LineItemResult> {
  const existing = update
    ? (update.record ?? (await services.odataClient.getRecord<Row>(collection, update.id)))
    : {};
  const merged: Row = { ...existing, ...data };
  const out: Row = { ...data };
  const notes: string[] = [];
  const parents = [guidOf(existing[cfg.fk]), guidOf(merged[cfg.fk])].filter((p): p is string => p !== null);

  // Смена продукта при обновлении: поля старого продукта не должны пережить её.
  const productChanged = update !== undefined && 'ProductId' in data && data.ProductId !== existing.ProductId;
  const needs = (field: string): boolean =>
    !(field in data) &&
    (isEmpty(merged[field]) || productChanged || (field === 'Price' && !num(merged[field])));

  const productId = guidOf(merged.ProductId);
  const product = productId
    ? await services.odataClient.getRecord<Row>('Product', productId, {
        $select: 'Name,Price,UnitId,TaxId',
      })
    : null;

  if (product && cfg.full) {
    for (const [field, label] of [
      ['Name', 'название'],
      ['UnitId', 'единица'],
      ['TaxId', 'налог'],
    ] as const) {
      if (needs(field) && !isEmpty(product[field])) {
        out[field] = merged[field] = product[field];
        notes.push(`${label} из продукта`);
      }
    }
  }

  if (product && needs('Price')) {
    const priceListId = guidOf(merged.PriceListId);
    const listed = priceListId
      ? (
          await services.odataClient.getRecords<Row>('ProductPrice', {
            $filter: `Product/Id eq ${guidLiteral(productId!, services.config.odata_version)} and PriceList/Id eq ${guidLiteral(priceListId, services.config.odata_version)}`,
            $select: 'Price',
            $top: 1,
          })
        ).value[0]
      : undefined;
    const price = r2(num(listed ? listed.Price : product.Price));
    out.Price = merged.Price = price;
    notes.push(`Цена из ${listed ? 'прайс-листа' : 'продукта'}: ${price}`);
  }

  if (merged.Quantity === undefined || merged.Quantity === null || merged.Quantity === '') {
    out.Quantity = merged.Quantity = 1;
    notes.push('Количество: 1');
  }

  const price = num(merged.Price);
  const quantity = num(merged.Quantity);
  const computed: Row = { Amount: r2(price * quantity) };

  if (cfg.full) {
    const amount = computed.Amount as number;
    const percent = num(merged.DiscountPercent);
    const discount = percent ? r2((amount * percent) / 100) : r2(num(merged.DiscountAmount));
    const total = r2(amount - discount);
    const taxId = guidOf(merged.TaxId);
    const taxPercent = taxId
      ? num((await services.odataClient.getRecord<Row>('Tax', taxId, { $select: 'Percent' })).Percent)
      : 0;
    // ponytail: налог «в том числе» (цена включает НДС) — взято из логики страницы продукта
    // платформы, на тестовом стенде не проверено. Если стенд считает налог сверху — поменять здесь.
    const tax = taxPercent ? r2((total * taxPercent) / (100 + taxPercent)) : 0;
    Object.assign(computed, { DiscountAmount: discount, TotalAmount: total, TaxAmount: tax });

    // ponytail: Primary* = суммы строки только при курсе 0/1 (валюта строки = базовая).
    // При другом курсе Primary* не трогаем: направление пересчёта курса на стенде не проверено.
    const rate = num(merged.CurrencyRate);
    if (rate === 0 || rate === 1) {
      Object.assign(computed, {
        PrimaryPrice: r2(price),
        PrimaryAmount: amount,
        PrimaryDiscountAmount: discount,
        PrimaryTaxAmount: tax,
        PrimaryTotalAmount: total,
      });
    }
  }

  for (const [field, value] of Object.entries(computed)) {
    // Primary* от вызывающего не трогаем; суммы строки держим согласованными всегда.
    if (field.startsWith('Primary') && field in data) continue;
    if (field in data && num(data[field]) !== value) {
      notes.push(`${field}: передано ${String(data[field])}, записано расчётное ${String(value)}`);
    }
    out[field] = value;
  }
  notes.push(`Сумма: ${String(computed.Amount)}`);
  if (cfg.full) {
    if (computed.DiscountAmount) notes.push(`Скидка: ${String(computed.DiscountAmount)}`);
    notes.push(`Итого: ${String(computed.TotalAmount)}`);
    if (computed.TaxAmount) notes.push(`Налог (в т. ч.): ${String(computed.TaxAmount)}`);
  }
  return { data: out, notes, parents: cfg.parent ? [...new Set(parents)] : [] };
}

/** Родители строк по их Id — читать до удаления, иначе пересчитывать будет нечего. */
export async function lineParentIds(
  services: ServiceContainer,
  collection: string,
  ids: string[]
): Promise<string[]> {
  const cfg = lineConfig(collection);
  if (!cfg?.parent || ids.length === 0) return [];
  const version = services.config.odata_version;
  const parents = new Set<string>();
  try {
    for (let i = 0; i < ids.length; i += QUERY_CHUNK) {
      const chunk = ids.slice(i, i + QUERY_CHUNK);
      const response = await services.odataClient.getRecords<Row>(collection, {
        $filter: chunk.map((id) => `Id eq ${guidLiteral(id, version)}`).join(' or '),
        $select: `Id,${cfg.fk}`,
        $top: chunk.length,
      });
      for (const row of response.value) {
        const parent = guidOf(row[cfg.fk]);
        if (parent) parents.add(parent);
      }
    }
  } catch {
    // Родителя не узнать — удаление всё равно выполняется, сумма просто не пересчитается.
  }
  return [...parents];
}

/**
 * Сумма родителя = сумма TotalAmount его строк (для счёта ещё AmountWithoutTax).
 * Строки берутся одним GET с навигационным фильтром `Order/Id eq <uuid>`: FK-форма
 * (`OrderId eq`) на тестовом стенде рвёт поток.
 */
export async function recalcParentTotals(
  services: ServiceContainer,
  collection: string,
  parentIds: string[]
): Promise<string[]> {
  const cfg = lineConfig(collection);
  if (!cfg?.full || !cfg.parent) return [];
  const parent = cfg.parent;
  const notes: string[] = [];
  for (const parentId of new Set(parentIds.filter((p) => guidOf(p)))) {
    try {
      const lines = await services.odataClient.getRecords<Row>(
        collection,
        {
          $filter: `${parent}/Id eq ${guidLiteral(parentId, services.config.odata_version)}`,
          $select: 'TotalAmount,TaxAmount',
        },
        true
      );
      const total = r2(lines.value.reduce((s, l) => s + num(l.TotalAmount), 0));
      const withoutTax = r2(lines.value.reduce((s, l) => s + num(l.TotalAmount) - num(l.TaxAmount), 0));
      const record = await services.odataClient.getRecord<Row>(parent, parentId, {
        $select: 'Number,CurrencyRate',
      });
      const rate = num(record.CurrencyRate);
      const primary = rate === 0 || rate === 1;
      const patch: Row = { Amount: total, ...(primary ? { PrimaryAmount: total } : {}) };
      if (parent === 'Invoice') {
        patch.AmountWithoutTax = withoutTax;
        if (primary) patch.PrimaryAmountWithoutTax = withoutTax;
      }
      await services.odataClient.updateRecord(parent, parentId, patch);
      const name = isEmpty(record.Number) ? parentId : String(record.Number);
      notes.push(`Сумма ${PARENT_LABEL[parent]} ${name} пересчитана: ${total}`);
    } catch (error) {
      notes.push(`Предупреждение: сумму ${parent}(${parentId}) пересчитать не удалось (${errorOf(error)})`);
    }
  }
  return notes;
}

/** Одна строка для текстового ответа инструмента. */
export function lineNotesText(notes: string[]): string {
  return notes.length ? `Расчёт строк: ${notes.join('; ')}` : '';
}
