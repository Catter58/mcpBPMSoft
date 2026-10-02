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
import { coerceFieldValue } from '../utils/field-values.js';
import {
  type Decimal,
  decimal,
  addDecimal,
  subtractDecimal,
  multiplyDecimal,
  compareDecimal,
  divideDecimal,
  roundDecimal,
  decimalText,
} from '../utils/decimal.js';

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

const ZERO = decimal(0);
const ONE = decimal(1);
const HUNDRED = decimal(100);
const num = (value: unknown): Decimal => {
  if (value === undefined || value === null || value === '') return ZERO;
  if (typeof value !== 'string' && typeof value !== 'number')
    throw new TypeError('Ожидается десятичное число.');
  return decimal(value);
};
const money = (value: Decimal): string => decimalText(roundDecimal(value, 2));
const baseCurrency = (rate: Decimal): boolean => rate.units === 0n || compareDecimal(rate, ONE) === 0;
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

/** Generated fields must pass the same EDM coercion as caller-provided values. */
async function normalizeFields(services: ServiceContainer, collection: string, data: Row): Promise<Row> {
  const metadata = await services.metadataManager.getEntityMetadata(collection);
  const properties = new Map(metadata.properties.map((property) => [property.name, property]));
  return Object.fromEntries(
    Object.entries(data).map(([field, value]) => {
      const property = properties.get(field);
      return [field, property ? coerceFieldValue(value, property, collection) : value];
    })
  );
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
    (isEmpty(merged[field]) || productChanged || (field === 'Price' && num(merged[field]).units === 0n));

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
    const price = money(num(listed ? listed.Price : product.Price));
    out.Price = merged.Price = price;
    notes.push(`Цена из ${listed ? 'прайс-листа' : 'продукта'}: ${price}`);
  }

  if (merged.Quantity === undefined || merged.Quantity === null || merged.Quantity === '') {
    out.Quantity = merged.Quantity = 1;
    notes.push('Количество: 1');
  }

  const price = num(merged.Price);
  const quantity = num(merged.Quantity);
  const amount = roundDecimal(multiplyDecimal(price, quantity), 2);
  const computed: Row = { Amount: decimalText(amount) };

  if (cfg.full) {
    const percent = num(merged.DiscountPercent);
    const discount =
      percent.units !== 0n
        ? divideDecimal(multiplyDecimal(amount, percent), HUNDRED, 2)
        : roundDecimal(num(merged.DiscountAmount), 2);
    const total = roundDecimal(subtractDecimal(amount, discount), 2);
    const taxId = guidOf(merged.TaxId);
    const taxPercent = taxId
      ? num((await services.odataClient.getRecord<Row>('Tax', taxId, { $select: 'Percent' })).Percent)
      : ZERO;
    // ponytail: налог «в том числе» (цена включает НДС) — взято из логики страницы продукта
    // платформы, на тестовом стенде не проверено. Если стенд считает налог сверху — поменять здесь.
    const tax =
      taxPercent.units !== 0n
        ? divideDecimal(multiplyDecimal(total, taxPercent), addDecimal(HUNDRED, taxPercent), 2)
        : ZERO;
    Object.assign(computed, {
      DiscountAmount: decimalText(discount),
      TotalAmount: decimalText(total),
      TaxAmount: decimalText(tax),
    });

    // ponytail: Primary* = суммы строки только при курсе 0/1 (валюта строки = базовая).
    // При другом курсе Primary* не трогаем: направление пересчёта курса на стенде не проверено.
    const rate = num(merged.CurrencyRate);
    if (baseCurrency(rate)) {
      Object.assign(computed, {
        PrimaryPrice: money(price),
        PrimaryAmount: decimalText(amount),
        PrimaryDiscountAmount: decimalText(discount),
        PrimaryTaxAmount: decimalText(tax),
        PrimaryTotalAmount: decimalText(total),
      });
    }
  }

  for (const [field, value] of Object.entries(computed)) {
    // Primary* от вызывающего не трогаем; суммы строки держим согласованными всегда.
    if (field.startsWith('Primary') && field in data) continue;
    if (field in data && compareDecimal(num(data[field]), num(value)) !== 0) {
      notes.push(`${field}: передано ${String(data[field])}, записано расчётное ${String(value)}`);
    }
    out[field] = value;
  }
  notes.push(`Сумма: ${String(computed.Amount)}`);
  if (cfg.full) {
    if (num(computed.DiscountAmount).units !== 0n) notes.push(`Скидка: ${String(computed.DiscountAmount)}`);
    notes.push(`Итого: ${String(computed.TotalAmount)}`);
    if (num(computed.TaxAmount).units !== 0n) notes.push(`Налог (в т. ч.): ${String(computed.TaxAmount)}`);
  }
  return {
    data: await normalizeFields(services, collection, out),
    notes,
    parents: cfg.parent ? [...new Set(parents)] : [],
  };
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
      const total = money(lines.value.reduce((sum, line) => addDecimal(sum, num(line.TotalAmount)), ZERO));
      const withoutTax = money(
        lines.value.reduce(
          (sum, line) => addDecimal(sum, subtractDecimal(num(line.TotalAmount), num(line.TaxAmount))),
          ZERO
        )
      );
      const record = await services.odataClient.getRecord<Row>(parent, parentId, {
        $select: 'Number,CurrencyRate',
      });
      const rate = num(record.CurrencyRate);
      const primary = baseCurrency(rate);
      const patch: Row = { Amount: total, ...(primary ? { PrimaryAmount: total } : {}) };
      if (parent === 'Invoice') {
        patch.AmountWithoutTax = withoutTax;
        if (primary) patch.PrimaryAmountWithoutTax = withoutTax;
      }
      await services.odataClient.updateRecord(
        parent,
        parentId,
        await normalizeFields(services, parent, patch)
      );
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
