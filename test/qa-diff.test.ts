import { describe, expect, it } from 'vitest';
import { diffBasket } from '../src/agents/qa/diff.js';
import type { BasketItem, CartLine } from '../src/shared/contracts.js';

const FILLET = 'Філе зі стегна індички, 1 кг';
const LIVER = 'Печінка індички, 500 г';
const EGGS = 'Курячі яйця від фермерських курей, 10 шт';
const PASTE = 'Горіхова паста з фунндуком 350 г';

const item = (name: string, qty: number): BasketItem => ({ name, qty });
const line = (name: string, qty: number, extra: Partial<CartLine> = {}): CartLine => ({ name, qty, ...extra });

describe('diffBasket: differences', () => {
  it('matches an identical basket', () => {
    const diff = diffBasket([item(FILLET, 2), item(LIVER, 1)], [line(LIVER, 1, { amount: 320 }), line(FILLET, 2)], []);
    expect(diff).toEqual({ verdict: 'match', differences: [], focus: [] });
  });

  it('reports an expected product that is not in the basket as missing', () => {
    const diff = diffBasket([item(FILLET, 2), item(LIVER, 1)], [line(FILLET, 2)]);
    expect(diff.verdict).toBe('mismatch');
    expect(diff.differences).toEqual([{ kind: 'missing', name: LIVER, expectedQty: 1, actualQty: 0 }]);
  });

  it('reports a basket line nobody ordered as extra', () => {
    const diff = diffBasket([item(FILLET, 2)], [line(FILLET, 2), line(EGGS, 3)]);
    expect(diff.verdict).toBe('mismatch');
    expect(diff.differences).toEqual([{ kind: 'extra', name: EGGS, expectedQty: 0, actualQty: 3 }]);
  });

  it('reports a different quantity in both directions', () => {
    const diff = diffBasket([item(FILLET, 2), item(LIVER, 1)], [line(FILLET, 1), line(LIVER, 4)]);
    expect(diff.differences).toEqual([
      { kind: 'quantity', name: FILLET, expectedQty: 2, actualQty: 1 },
      { kind: 'quantity', name: LIVER, expectedQty: 1, actualQty: 4 },
    ]);
  });

  it('lists expected-side differences in order first, then extras in basket order', () => {
    const diff = diffBasket([item(FILLET, 1), item(LIVER, 2)], [line(PASTE, 1), line(LIVER, 1), line(EGGS, 2)]);
    expect(diff.differences.map((d) => [d.kind, d.name])).toEqual([
      ['missing', FILLET],
      ['quantity', LIVER],
      ['extra', PASTE],
      ['extra', EGGS],
    ]);
  });

  it('sums duplicate basket lines with the same product before comparing', () => {
    expect(diffBasket([item(FILLET, 3)], [line(FILLET, 1), line(FILLET, 2)]).verdict).toBe('match');
    expect(diffBasket([item(FILLET, 2)], [line(FILLET, 1), line(` ${FILLET.toUpperCase()} `, 2)]).differences).toEqual([
      { kind: 'quantity', name: FILLET, expectedQty: 2, actualQty: 3 },
    ]);
  });

  it('sums duplicate expected items with the same product', () => {
    expect(diffBasket([item(FILLET, 1), item(FILLET, 1)], [line(FILLET, 2)]).verdict).toBe('match');
  });

  it('matches names case-insensitively with collapsed whitespace', () => {
    const diff = diffBasket([item(FILLET, 2)], [line('  філе ЗІ стегна індички,   1 КГ ', 2)]);
    expect(diff.verdict).toBe('match');
  });

  it('treats typographic and straight apostrophes and dashes as the same', () => {
    const expected = [item("Пиріжки з м'ясом", 1), item('Котлети по-київськи – 900 г', 1)];
    const cart = [line('Пиріжки з м’ясом', 1), line('Котлети по-київськи — 900 г', 1)];
    expect(diffBasket(expected, cart).verdict).toBe('match');
    expect(diffBasket([item('Мʼясо', 1)], [line('М`ясо', 1)]).verdict).toBe('match');
  });

  it('does not confuse products whose names only differ by a word', () => {
    const diff = diffBasket([item('Фарш з філе зі стегна індички, 1 кг', 1)], [line('Фарш з філе індички, 1 кг', 1)]);
    expect(diff.differences.map((d) => d.kind)).toEqual(['missing', 'extra']);
  });

  it('keeps the display name from the order for missing/quantity and from the basket for extras', () => {
    const diff = diffBasket([item('ФІЛЕ зі стегна індички, 1 кг', 1)], [line(FILLET, 2), line('яйця ', 1)]);
    expect(diff.differences).toEqual([
      { kind: 'quantity', name: 'ФІЛЕ зі стегна індички, 1 кг', expectedQty: 1, actualQty: 2 },
      { kind: 'extra', name: 'яйця ', expectedQty: 0, actualQty: 1 },
    ]);
  });

  it('ignores basket lines with quantity 0', () => {
    expect(diffBasket([item(FILLET, 1)], [line(FILLET, 1), line(EGGS, 0)]).verdict).toBe('match');
    expect(diffBasket([item(FILLET, 1)], [line(FILLET, 0)]).differences).toEqual([
      { kind: 'missing', name: FILLET, expectedQty: 1, actualQty: 0 },
    ]);
  });

  it('reports every expected product as missing when the basket is empty', () => {
    const diff = diffBasket([item(FILLET, 2), item(LIVER, 1)], []);
    expect(diff.verdict).toBe('mismatch');
    expect(diff.differences).toEqual([
      { kind: 'missing', name: FILLET, expectedQty: 2, actualQty: 0 },
      { kind: 'missing', name: LIVER, expectedQty: 1, actualQty: 0 },
    ]);
  });

  it('matches an empty order against an empty basket', () => {
    expect(diffBasket([], [])).toEqual({ verdict: 'match', differences: [], focus: [] });
  });

  it('flags everything as extra when nothing was ordered', () => {
    expect(diffBasket([], [line(EGGS, 1)]).differences).toEqual([{ kind: 'extra', name: EGGS, expectedQty: 0, actualQty: 1 }]);
  });
});

describe('diffBasket: focus checks', () => {
  it('quantity: passes when the basket shows the given quantity', () => {
    const diff = diffBasket([item(FILLET, 2)], [line(FILLET, 2)], [{ name: FILLET, check: 'quantity', expectedQty: 2 }]);
    expect(diff.focus).toEqual([{ name: FILLET, check: 'quantity', expectedQty: 2, actualQty: 2, passed: true }]);
    expect(diff.verdict).toBe('match');
  });

  it('quantity: fails when the basket shows another quantity', () => {
    const diff = diffBasket([item(FILLET, 2)], [line(FILLET, 1)], [{ name: FILLET, check: 'quantity', expectedQty: 2 }]);
    expect(diff.focus[0]).toMatchObject({ passed: false, actualQty: 1, expectedQty: 2 });
    expect(diff.verdict).toBe('mismatch');
  });

  it('quantity: without expectedQty uses the expected basket quantity', () => {
    const ok = diffBasket([item(FILLET, 3)], [line(FILLET, 3)], [{ name: FILLET, check: 'quantity' }]);
    expect(ok.focus[0]).toMatchObject({ expectedQty: 3, actualQty: 3, passed: true });
    const notOrdered = diffBasket([], [line(EGGS, 1)], [{ name: EGGS, check: 'quantity' }]);
    expect(notOrdered.focus[0]).toMatchObject({ expectedQty: 0, actualQty: 1, passed: false });
  });

  it('present: passes for any positive quantity unless a quantity is given', () => {
    const cart = [line(EGGS, 2)];
    expect(diffBasket([item(EGGS, 2)], cart, [{ name: EGGS, check: 'present' }]).focus[0]).toMatchObject({ passed: true, actualQty: 2 });
    expect(diffBasket([item(EGGS, 2)], cart, [{ name: EGGS, check: 'present', expectedQty: 2 }]).focus[0]?.passed).toBe(true);
    expect(diffBasket([item(EGGS, 2)], cart, [{ name: EGGS, check: 'present', expectedQty: 1 }]).focus[0]?.passed).toBe(false);
    expect(diffBasket([item(EGGS, 2)], [], [{ name: EGGS, check: 'present' }]).focus[0]).toMatchObject({ passed: false, actualQty: 0 });
  });

  it('absent: passes only when the product is gone', () => {
    expect(diffBasket([], [], [{ name: PASTE, check: 'absent' }]).focus[0]).toMatchObject({ passed: true, actualQty: 0 });
    expect(diffBasket([], [line(PASTE, 0)], [{ name: PASTE, check: 'absent' }]).focus[0]?.passed).toBe(true);
    const still = diffBasket([], [line(PASTE, 1)], [{ name: PASTE, check: 'absent' }]);
    expect(still.focus[0]).toMatchObject({ passed: false, actualQty: 1 });
    expect(still.verdict).toBe('mismatch');
  });

  it('matches focus names with the same normalization as the diff', () => {
    const diff = diffBasket([item("М'ясо", 2)], [line('м’ясо ', 2)], [{ name: 'М’ЯСО', check: 'quantity', expectedQty: 2 }]);
    expect(diff.focus[0]?.passed).toBe(true);
    expect(diff.verdict).toBe('match');
  });

  it('sums duplicate basket lines for focus checks', () => {
    const diff = diffBasket([item(FILLET, 2)], [line(FILLET, 1), line(FILLET, 1)], [{ name: FILLET, check: 'quantity', expectedQty: 2 }]);
    expect(diff.focus[0]).toMatchObject({ actualQty: 2, passed: true });
  });

  it('is a mismatch when a focus check fails even if the basket equals the order', () => {
    // COS expects the line removed but its expected basket still lists it: the focus check decides.
    const diff = diffBasket([item(EGGS, 1)], [line(EGGS, 1)], [{ name: EGGS, check: 'absent' }]);
    expect(diff.differences).toEqual([]);
    expect(diff.verdict).toBe('mismatch');
  });

  it('keeps focus results in request order', () => {
    const diff = diffBasket(
      [item(FILLET, 2)],
      [line(FILLET, 2)],
      [
        { name: EGGS, check: 'absent' },
        { name: FILLET, check: 'present' },
      ],
    );
    expect(diff.focus.map((f) => f.name)).toEqual([EGGS, FILLET]);
  });
});
