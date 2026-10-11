import { normalizeName, type BasketItem, type Selection } from '../contracts.js';
import type { Product } from './product-list.js';

/** BasketItem.qty upper bound in the contract. */
const MAX_QTY = 99;

export const QUESTION_HEAD =
  'Що замовити? Напишіть номер товару і кількість, кожен товар з нового рядка, у форматі «номер - кількість». Без кількості = 1 шт.';

/**
 * The select-products question, rendered in code from the product table: the numbers the user answers with
 * are the table rows, so the answer maps back to exact names without the model copying a 20-line list.
 */
export function productQuestion(products: readonly Product[], standing: readonly BasketItem[] = []): string {
  const always = standing.length
    ? [
        `Завжди додається до замовлення: ${standing.map((i) => `${i.name} × ${i.qty}`).join('; ')}. ` +
          'Якщо більше нічого не треба, напишіть «0».',
      ]
    : [];
  return [
    QUESTION_HEAD,
    ...always,
    'Наприклад:',
    '1 - 2',
    '5',
    '',
    ...products.map((p, i) => `${i + 1}. ${p.name}${p.priceUah !== undefined ? ` — ≈${p.priceUah} грн` : ''}`),
  ].join('\n');
}

/** One product the user chose, as the model reads the answer: the table row, the name as a cross-check, the quantity. */
export interface SelectedRow {
  row: number;
  name: string;
  qty: number;
}

/**
 * Turn the model's rows into a Selection with the exact table names and SKUs. The row decides: it is the
 * number the user answered with. A row outside the table falls back to the name.
 */
export function selectionFromRows(
  shopId: string,
  rows: readonly SelectedRow[],
  products: readonly Product[],
  notes?: string,
): Selection {
  const items: BasketItem[] = [];
  const remarks: string[] = [];
  for (const { row, name, qty } of rows) {
    const product = products[row - 1];
    if (!product) {
      items.push({ name, qty });
      continue;
    }
    if (normalizeName(name) !== normalizeName(product.name)) remarks.push(`#${row} is "${product.name}" (the agent wrote "${name}"); used #${row}.`);
    items.push({ name: product.name, qty, ...(product.sku ? { sku: product.sku } : {}) });
  }
  const allNotes = [notes, ...remarks].filter(Boolean).join('\n');
  return canonicalizeSelection({ type: 'selection', shopId, items, ...(allNotes ? { notes: allNotes } : {}) }, products);
}

/** "1. Філе зі стегна індички, 1 кг — ≈665 грн" -> "Філе зі стегна індички, 1 кг": a line copied from the question. */
function withoutQuestionDecoration(name: string): string {
  return name
    .replace(/^\s*\d+\.\s+/, '')
    .replace(/\s*(?:[—–-]\s*)?\(?≈?\s*\d[\d\s]*(?:[.,]\d+)?\s*грн\.?\)?\s*$/i, '');
}

/**
 * Make the model's selection safe to hand to Execute: names become the exact product-list names
 * (the shop matches names character for character) and repeated products collapse into one line.
 * A name that is not listed is matched without the question's numbering and price, then by a SKU that
 * belongs to exactly one product; still unknown, it is kept as given and called out in the notes.
 */
export function canonicalizeSelection(selection: Selection, products: readonly Product[]): Selection {
  const listed = new Map(products.map((p) => [normalizeName(p.name), p]));
  const bySku = (sku: string | undefined) => {
    const matches = sku ? products.filter((p) => p.sku === sku) : [];
    return matches.length === 1 ? matches[0] : undefined;
  };
  const lines = new Map<string, BasketItem>();
  const unlisted: string[] = [];

  for (const item of selection.items) {
    const product =
      listed.get(normalizeName(item.name)) ?? listed.get(normalizeName(withoutQuestionDecoration(item.name))) ?? bySku(item.sku);
    const key = normalizeName(product?.name ?? item.name);
    const line = lines.get(key);
    if (line) {
      line.qty = Math.min(MAX_QTY, line.qty + item.qty);
      continue;
    }
    if (!product) unlisted.push(item.name);
    const sku = product ? product.sku : item.sku;
    lines.set(key, { name: product?.name ?? item.name.trim(), qty: item.qty, ...(sku ? { sku } : {}) });
  }

  const notes = [selection.notes, unlisted.length ? `Not in the product list, kept as given: ${unlisted.join('; ')}` : '']
    .filter(Boolean)
    .join('\n');
  return { type: 'selection', shopId: selection.shopId, items: [...lines.values()], ...(notes ? { notes } : {}) };
}

/**
 * COS's every-order products (from its memory) as exact product-list names. A name the list does not have is
 * refused: Execute could not find it in the shop either.
 */
export function resolveStanding(items: ReadonlyArray<{ name: string; qty: number }>, products: readonly Product[]): BasketItem[] {
  const resolved = canonicalizeSelection({ type: 'selection', shopId: '', items: items.map(({ name, qty }) => ({ name, qty })) }, products);
  const listed = new Set(products.map((p) => normalizeName(p.name)));
  const unknown = resolved.items.filter((i) => !listed.has(normalizeName(i.name))).map((i) => i.name);
  if (unknown.length) {
    throw new Error(
      `Not in the product list: ${unknown.join('; ')}. Start the task without them and tell the user; a product goes into ` +
        'every order only once it is in the product list (explore update-product-list).',
    );
  }
  return resolved.items;
}

/** A new order's selection plus the products the user wants in every order (quantities of a product chosen too add up). */
export function withStanding(selection: Selection, standing: readonly BasketItem[], products: readonly Product[]): Selection {
  if (standing.length === 0) return selection;
  const note = `Added to every order: ${standing.map((i) => `${i.name} × ${i.qty}`).join('; ')}.`;
  const notes = [selection.notes, note].filter(Boolean).join('\n');
  return canonicalizeSelection({ ...selection, items: [...selection.items, ...standing], notes }, products);
}
