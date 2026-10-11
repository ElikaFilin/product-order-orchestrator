import { describe, expect, it } from 'vitest';
import { canonicalizeSelection, productQuestion, QUESTION_HEAD, resolveStanding, selectionFromRows, withStanding } from '../src/core/explore/selection.js';

const PASTE = 'Горіхова паста з фунндуком 350 г';
const KYIV = 'Котлети по-київськи з індички, 900 г';
const FILLET = 'Філе зі стегна індички, 1 кг';
const products = [
  { name: FILLET, sku: '1', priceUah: 665 },
  { name: PASTE, sku: '513', priceUah: 850 },
  { name: KYIV },
];

describe('productQuestion', () => {
  it('numbers the products as the table rows, with the price when there is one', () => {
    expect(productQuestion(products)).toBe(
      [QUESTION_HEAD, 'Наприклад:', '1 - 2', '5', '', `1. ${FILLET} — ≈665 грн`, `2. ${PASTE} — ≈850 грн`, `3. ${KYIV}`].join('\n'),
    );
  });
});

describe('every-order (standing) products', () => {
  it('the question says they are always added', () => {
    const question = productQuestion(products, [{ name: FILLET, qty: 1 }]).split('\n');
    expect(question.slice(0, 2)).toEqual([QUESTION_HEAD, `Завжди додається до замовлення: ${FILLET} × 1. Якщо більше нічого не треба, напишіть «0».`]);
  });

  it('resolves names to the exact list names and SKUs, and refuses names the list does not have', () => {
    expect(resolveStanding([{ name: ` ${FILLET.toUpperCase()} `, qty: 1 }], products)).toEqual([{ name: FILLET, qty: 1, sku: '1' }]);
    expect(() => resolveStanding([{ name: 'Шоколад', qty: 1 }], products)).toThrow(/Not in the product list: Шоколад/);
  });

  it('adds them to the selection: a product the user chose too adds up, nothing chosen means only them', () => {
    const chosen = selectionFromRows('karashynyard', [{ row: 1, name: FILLET, qty: 2 }, { row: 2, name: PASTE, qty: 1 }], products);
    const standing = [{ name: FILLET, qty: 1, sku: '1' }];
    const selection = withStanding(chosen, standing, products);
    expect(selection.items).toEqual([
      { name: FILLET, qty: 3, sku: '1' },
      { name: PASTE, qty: 1, sku: '513' },
    ]);
    expect(selection.notes).toBe(`Added to every order: ${FILLET} × 1.`);
    expect(withStanding(selectionFromRows('karashynyard', [], products), standing, products).items).toEqual(standing);
    expect(withStanding(chosen, [], products)).toBe(chosen);
  });
});

describe('selectionFromRows', () => {
  it('takes the exact name and SKU from the row the user chose, whatever name the model wrote', () => {
    const selection = selectionFromRows(
      'karashynyard',
      [
        { row: 2, name: 'Горіхова паста з фундуком 350 г', qty: 1 },
        { row: 1, name: FILLET, qty: 2 },
      ],
      products,
    );
    expect(selection.items).toEqual([
      { name: PASTE, qty: 1, sku: '513' },
      { name: FILLET, qty: 2, sku: '1' },
    ]);
    expect(selection.notes).toBe(`#2 is "${PASTE}" (the agent wrote "Горіхова паста з фундуком 350 г"); used #2.`);
  });

  it('falls back to the name for a row outside the table, and merges repeated products', () => {
    const selection = selectionFromRows(
      'karashynyard',
      [
        { row: 9, name: KYIV, qty: 1 },
        { row: 3, name: KYIV, qty: 2 },
      ],
      products,
      'Line "9" was unclear.',
    );
    expect(selection.items).toEqual([{ name: KYIV, qty: 3 }]);
    expect(selection.notes).toBe('Line "9" was unclear.');
  });
});

describe('canonicalizeSelection', () => {
  it('maps names to the exact list names, takes SKUs from the list and merges repeated products', () => {
    const selection = canonicalizeSelection(
      {
        type: 'selection',
        shopId: 'karashynyard',
        items: [
          { name: 'горіхова паста з фунндуком 350 г', qty: 2, sku: 'made-up' },
          { name: 'котлети по-київськи з індички, 900 г', qty: 1 },
          { name: ' Горіхова  паста з фунндуком 350 г ', qty: 97 },
        ],
      },
      products,
    );

    expect(selection.items).toEqual([
      { name: PASTE, qty: 99, sku: '513' }, // 2 + 97, capped at the contract maximum
      { name: KYIV, qty: 1 },
    ]);
    expect(selection.notes).toBeUndefined();
  });

  it('recognises a line copied from the question (number and price) and a unique SKU', () => {
    const selection = canonicalizeSelection(
      {
        type: 'selection',
        shopId: 'karashynyard',
        items: [
          { name: `1. ${FILLET} — ≈665 грн`, qty: 1 },
          { name: 'Горіхова паста з фундуком 350 г', qty: 1, sku: '513' },
        ],
      },
      products,
    );
    expect(selection.items).toEqual([
      { name: FILLET, qty: 1, sku: '1' },
      { name: PASTE, qty: 1, sku: '513' },
    ]);
    expect(selection.notes).toBeUndefined();
  });

  it('keeps unknown products as given and appends the note to the model notes', () => {
    const selection = canonicalizeSelection(
      {
        type: 'selection',
        shopId: 'karashynyard',
        items: [{ name: 'Сир твердий', qty: 1, sku: '999' }],
        notes: 'Line "99 - 1" dropped: no such number.',
      },
      products,
    );

    expect(selection.items).toEqual([{ name: 'Сир твердий', qty: 1, sku: '999' }]);
    expect(selection.notes).toBe('Line "99 - 1" dropped: no such number.\nNot in the product list, kept as given: Сир твердий');
  });
});
