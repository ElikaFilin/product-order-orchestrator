import { describe, expect, it } from 'vitest';
import { OrderState } from '../src/core/order-state.js';
import type { ExecuteResult, QaResult, Selection } from '../src/core/contracts.js';

const SHOP = 'karashynyard';
const FILLET = 'Філе зі стегна індички, 1 кг';
const THIGH = 'Стегно індички, 1 кг';
const LIVER = 'Печінка індички, 500 г';
const PASTE = 'Горіхова паста з фунндуком 350 г';

const selection: Selection = {
  type: 'selection',
  shopId: SHOP,
  items: [
    { name: FILLET, qty: 2, sku: '1' },
    { name: THIGH, qty: 1, sku: '8' },
    { name: LIVER, qty: 1 },
  ],
};

function executeResult(ops: ExecuteResult['ops']): ExecuteResult {
  return { type: 'execute-result', shopId: SHOP, cartUrl: 'https://karashynyard.com.ua/#opencart', ops, cart: [] };
}

function qaResult(partial: Pick<QaResult, 'verdict' | 'cart' | 'differences'> & Partial<QaResult>): QaResult {
  return { type: 'qa-result', shopId: SHOP, modalOpened: true, focus: [], cartUrl: 'https://karashynyard.com.ua/#opencart', ...partial };
}

describe('OrderState', () => {
  it('runs selection -> execute (ok/not_found) -> qa mismatch -> fix -> focused re-check -> accept extras', () => {
    const state = new OrderState(SHOP);
    const orderId = state.orderId;

    // Selection becomes the expected basket and the initial execute request.
    state.applySelection(selection);
    expect(state.executeInitialRequest()).toEqual({
      type: 'execute-request',
      shopId: SHOP,
      mode: 'initial',
      ops: [
        { name: FILLET, targetQty: 2, sku: '1' },
        { name: THIGH, targetQty: 1, sku: '8' },
        { name: LIVER, targetQty: 1 },
      ],
    });

    // Initial execute: liver not found. Expected stays as the user wants it; QA compares the whole basket (no re-checks).
    state.applyExecuteResult(
      executeResult([
        { name: FILLET, targetQty: 2, status: 'ok', actualQty: 2 },
        { name: THIGH, targetQty: 1, status: 'ok', actualQty: 1 },
        { name: LIVER, targetQty: 1, status: 'not_found' },
      ]),
      'initial',
    );
    expect(state.needsCheck).toBe(true);
    expect(state.expectedItems().map((i) => [i.name, i.qty])).toEqual([
      [FILLET, 2],
      [THIGH, 1],
      [LIVER, 1],
    ]);
    expect(state.qaRequest().focus).toEqual([]);

    // QA: liver missing, thigh has 3, an old paste line is still in the basket.
    state.applyQaResult(
      qaResult({
        verdict: 'mismatch',
        cart: [
          { name: FILLET, qty: 2 },
          { name: THIGH, qty: 3 },
          { name: PASTE, qty: 1 },
        ],
        differences: [
          { kind: 'quantity', name: THIGH, expectedQty: 1, actualQty: 3 },
          { kind: 'missing', name: LIVER, expectedQty: 1, actualQty: 0 },
          { kind: 'extra', name: PASTE, expectedQty: 0, actualQty: 1 },
        ],
      }),
    );
    expect(state.needsCheck).toBe(false);
    expect(state.isVerified()).toBe(false);
    expect(state.openDifferences()).toHaveLength(3);

    // The user: thigh back to 1, liver 2, remove the paste. Names typed loosely by the model are canonicalised.
    const fix = state.executeFixRequest([
      { name: '  стегно   індички, 1 кг ', targetQty: 1 },
      { name: LIVER, targetQty: 2 },
      { name: PASTE.toUpperCase(), targetQty: 0 },
    ]);
    expect(fix).toEqual({
      type: 'execute-request',
      shopId: SHOP,
      mode: 'fix',
      ops: [
        { name: THIGH, targetQty: 1, sku: '8' },
        { name: LIVER, targetQty: 2 },
        { name: PASTE, targetQty: 0 },
      ],
    });

    state.applyExecuteResult(
      executeResult([
        { name: THIGH, targetQty: 1, status: 'ok', actualQty: 1 },
        { name: LIVER, targetQty: 2, status: 'ok', actualQty: 2 },
        { name: PASTE, targetQty: 0, status: 'ok', actualQty: 0 },
      ]),
      'fix',
    );
    // Thigh was in the basket -> quantity; liver was missing -> present; paste removed -> absent.
    const recheck = state.qaRequest();
    expect(recheck.focus).toEqual([
      { name: THIGH, check: 'quantity', expectedQty: 1 },
      { name: LIVER, check: 'present', expectedQty: 2 },
      { name: PASTE, check: 'absent' },
    ]);
    expect(recheck.expected.map((i) => [i.name, i.qty])).toEqual([
      [FILLET, 2],
      [THIGH, 1],
      [LIVER, 2],
    ]);
    // An explicit focus (an extra check the user asked for) is added to the derived re-checks; per product it wins.
    expect(state.qaRequest([{ name: FILLET, check: 'quantity', expectedQty: 2 }]).focus).toEqual([
      { name: THIGH, check: 'quantity', expectedQty: 1 },
      { name: LIVER, check: 'present', expectedQty: 2 },
      { name: PASTE, check: 'absent' },
      { name: FILLET, check: 'quantity', expectedQty: 2 },
    ]);
    expect(state.qaRequest([{ name: 'стегно індички, 1 кг', check: 'present' }]).focus).toEqual([
      { name: THIGH, check: 'present' },
      { name: LIVER, check: 'present', expectedQty: 2 },
      { name: PASTE, check: 'absent' },
    ]);
    expect(state.qaRequest([]).focus).toHaveLength(3);

    // Re-check: the paste could not be removed after all. The user decides to keep it.
    state.applyQaResult(
      qaResult({
        verdict: 'mismatch',
        cart: [
          { name: FILLET, qty: 2 },
          { name: THIGH, qty: 1 },
          { name: LIVER, qty: 2 },
          { name: PASTE, qty: 1 },
        ],
        differences: [{ kind: 'extra', name: PASTE, expectedQty: 0, actualQty: 1 }],
      }),
    );
    expect(state.isVerified()).toBe(false);
    // The re-checks were used by that QA run: a later check without a fix has none.
    expect(state.qaRequest().focus).toEqual([]);
    expect(state.acceptItems([{ name: PASTE, qty: 1 }])).toEqual([]);
    expect(state.isVerified()).toBe(true);
    expect(state.expectedItems().map((i) => i.name)).toContain(PASTE);
    expect(state.summary()).toContain('Basket verified');
    expect(state.orderId).toBe(orderId);
  });

  it('a failed fix operation leaves the expected basket and the focus alone', () => {
    const state = new OrderState(SHOP);
    state.applySelection(selection);
    state.applyExecuteResult(executeResult([{ name: FILLET, targetQty: 5, status: 'failed', detail: 'button disabled' }]), 'fix');
    expect(state.expectedItems().find((i) => i.name === FILLET)?.qty).toBe(2);
    expect(state.qaRequest().focus).toEqual([]);
    expect(state.summary()).toContain(`${FILLET} (failed)`);
  });

  it('accepting qty 0 drops a line the user does not want, resolving a missing difference', () => {
    const state = new OrderState(SHOP);
    state.applySelection(selection);
    state.applyQaResult(
      qaResult({
        verdict: 'mismatch',
        cart: [
          { name: FILLET, qty: 2 },
          { name: THIGH, qty: 1 },
        ],
        differences: [{ kind: 'missing', name: LIVER, expectedQty: 1, actualQty: 0 }],
      }),
    );
    expect(state.acceptItems([{ name: LIVER, qty: 0 }])).toEqual([]);
    expect(state.expectedItems().map((i) => i.name)).toEqual([FILLET, THIGH]);
    expect(state.isVerified()).toBe(true);
  });

  it('builds explore requests', () => {
    const state = new OrderState(SHOP);
    expect(state.exploreSelectRequest()).toEqual({ type: 'explore-request', action: 'select-products', shopId: SHOP });
    expect(state.exploreUpdateRequest(['Нова паста'], [])).toEqual({
      type: 'explore-request',
      action: 'update-product-list',
      shopId: SHOP,
      add: ['Нова паста'],
      remove: [],
    });
    expect(() => state.exploreUpdateRequest([], [])).toThrow(/add or remove/);
  });

  it('refuses an initial execute without a selection and resets to a fresh order', () => {
    const state = new OrderState(SHOP);
    expect(() => state.executeInitialRequest()).toThrow(/empty/);
    expect(() => state.executeFixRequest([])).toThrow(/at least one/);

    state.applySelection(selection);
    const before = state.orderId;
    state.reset();
    expect(state.orderId).not.toBe(before);
    expect(state.expectedItems()).toEqual([]);
    expect(state.lastQa).toBeUndefined();
  });

  it('drops a re-check the user overrode by accepting the line, so a later check cannot contradict the order', () => {
    const state = new OrderState(SHOP);
    state.applySelection(selection);
    state.applyExecuteResult(executeResult([{ name: FILLET, targetQty: 2, status: 'ok', actualQty: 2 }]), 'initial');
    const basket = (fillet: number) => [{ name: FILLET, qty: fillet }, { name: THIGH, qty: 1 }, { name: LIVER, qty: 1 }];
    state.applyQaResult(qaResult({ verdict: 'mismatch', cart: basket(1), differences: [{ kind: 'quantity', name: FILLET, expectedQty: 2, actualQty: 1 }] }));

    // A fix to 3 is reported ok, then the user keeps 2 before QA looked: the "must now be 3" re-check is gone.
    state.applyExecuteResult(executeResult([{ name: FILLET, targetQty: 3, status: 'ok', actualQty: 3 }]), 'fix');
    expect(state.qaRequest().focus).toEqual([{ name: FILLET, check: 'quantity', expectedQty: 3 }]);
    state.acceptItems([{ name: FILLET, qty: 2 }]);
    expect(state.qaRequest().focus).toEqual([]);

    // Same after a QA run that saw 2: the user keeps 2, and checking again sends no contradicting re-check.
    state.applyExecuteResult(executeResult([{ name: FILLET, targetQty: 3, status: 'ok', actualQty: 3 }]), 'fix');
    state.applyQaResult(qaResult({ verdict: 'mismatch', cart: basket(2), differences: [{ kind: 'quantity', name: FILLET, expectedQty: 3, actualQty: 2 }] }));
    expect(state.acceptItems([{ name: FILLET, qty: 2 }])).toEqual([]);
    expect(state.isVerified()).toBe(true);
    const again = state.qaRequest();
    expect(again.focus).toEqual([]);
    expect(again.expected.find((i) => i.name === FILLET)?.qty).toBe(2);
  });

  it('a basket read only from the browser storage is never verified', () => {
    const state = new OrderState(SHOP);
    state.applySelection(selection);
    state.applyQaResult(
      qaResult({ verdict: 'match', modalOpened: false, cart: [{ name: FILLET, qty: 2 }, { name: THIGH, qty: 1 }, { name: LIVER, qty: 1 }], differences: [] }),
    );
    expect(state.openDifferences()).toEqual([]);
    expect(state.isVerified()).toBe(false);
    expect(state.summary()).toContain('the basket window did not open');
  });

  it('a merge selection adds to the expected basket and asks for a new check', () => {
    const state = new OrderState(SHOP);
    state.applySelection(selection);
    state.applyQaResult(qaResult({ verdict: 'match', cart: [{ name: FILLET, qty: 2 }, { name: THIGH, qty: 1 }, { name: LIVER, qty: 1 }], differences: [] }));
    expect(state.isVerified()).toBe(true);
    expect(state.exploreSelectRequest(true)).toEqual({ type: 'explore-request', action: 'select-products', shopId: SHOP, merge: true });

    state.applySelection({ type: 'selection', shopId: SHOP, items: [{ name: PASTE, qty: 1, sku: '513' }, { name: FILLET, qty: 1 }] }, true);
    expect(state.expectedItems().map((i) => [i.name, i.qty])).toEqual([
      [FILLET, 3],
      [THIGH, 1],
      [LIVER, 1],
      [PASTE, 1],
    ]);
    expect(state.isVerified()).toBe(false);
    expect(state.executeInitialRequest().ops).toHaveLength(4);
  });

  it('merge on an order without a selection is a plain selection', () => {
    const state = new OrderState(SHOP);
    expect(state.exploreSelectRequest(true)).toEqual({ type: 'explore-request', action: 'select-products', shopId: SHOP });
    state.applySelection(selection, true);
    expect(state.expectedItems()).toHaveLength(3);
  });

  it('replacing a product that was not found removes it from the order and re-checks both lines', () => {
    const state = new OrderState(SHOP);
    state.applySelection(selection);
    state.applyExecuteResult(executeResult([{ name: LIVER, targetQty: 1, status: 'not_found', detail: 'closest: Печінка курочки, 500 г' }]), 'initial');
    const fix = state.executeFixRequest([
      { name: LIVER, targetQty: 0 },
      { name: 'Печінка курочки, 500 г', targetQty: 1 },
    ]);
    state.applyExecuteResult(executeResult(fix.ops.map((op) => ({ ...op, status: 'ok', actualQty: op.targetQty }))), 'fix');
    expect(state.expectedItems().map((i) => i.name)).toEqual([FILLET, THIGH, 'Печінка курочки, 500 г']);
    expect(state.qaRequest().focus).toEqual([
      { name: LIVER, check: 'absent' },
      { name: 'Печінка курочки, 500 г', check: 'present', expectedQty: 1 },
    ]);
  });

  it('survives a snapshot round trip, including a pending re-check', () => {
    const state = new OrderState(SHOP);
    state.applySelection(selection);
    state.applyExecuteResult(executeResult(state.executeInitialRequest().ops.map((op) => ({ ...op, status: 'ok', actualQty: op.targetQty }))), 'initial');
    const fix = state.executeFixRequest([{ name: FILLET, targetQty: 3 }]);
    state.applyExecuteResult(executeResult(fix.ops.map((op) => ({ ...op, status: 'ok', actualQty: op.targetQty }))), 'fix');

    const snapshot = JSON.parse(JSON.stringify(state.snapshot()));
    const restored = OrderState.fromSnapshot(snapshot);
    expect(restored.orderId).toBe(state.orderId);
    expect(restored.expectedItems()).toEqual(state.expectedItems());
    expect(restored.qaRequest()).toEqual(state.qaRequest());
    expect(restored.needsCheck).toBe(true);
    expect(restored.snapshot()).toEqual(state.snapshot());
  });
});
