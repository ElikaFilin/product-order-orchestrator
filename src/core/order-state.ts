/**
 * The order COS is working on, kept in code rather than in the LLM's memory: the expected basket and what QA
 * should re-check after a change. Every sub-agent request COS sends is built here, so no JSON is retyped by the
 * model. It serializes to a plain snapshot so it survives gateway restarts.
 */
import { randomUUID } from 'node:crypto';
import {
  normalizeName,
  type BasketItem,
  type BasketOp,
  type Difference,
  type ExecuteRequest,
  type ExecuteResult,
  type ExploreRequest,
  type QaFocus,
  type QaRequest,
  type QaResult,
  type Selection,
} from './contracts.js';
import { describeOrderForm } from './order-form.js';

export interface ItemQty {
  name: string;
  qty: number;
}

export type ExecuteMode = ExecuteRequest['mode'];

/** BasketItem.qty upper bound in the contract. */
const MAX_QTY = 99;

/** Everything an OrderState holds, as plain JSON. */
export interface OrderStateSnapshot {
  shopId: string;
  orderId: string;
  expected: BasketItem[];
  lastExecute?: ExecuteResult;
  lastQa?: QaResult;
  lastFocus: QaFocus[];
  needsCheck: boolean;
}

export class OrderState {
  /** Identifies the order; every task of the order carries it. */
  orderId: string = randomUUID();
  lastExecute: ExecuteResult | undefined;
  lastQa: QaResult | undefined;
  /** What QA should re-check after a fix: derived from its successful operations, used by the next QA check. */
  lastFocus: QaFocus[] = [];
  /** The basket changed after the last QA check. */
  needsCheck = false;
  private readonly expected = new Map<string, BasketItem>();

  constructor(readonly shopId: string) {}

  static fromSnapshot(snapshot: OrderStateSnapshot): OrderState {
    const state = new OrderState(snapshot.shopId);
    state.orderId = snapshot.orderId;
    for (const item of snapshot.expected) state.expected.set(normalizeName(item.name), { ...item });
    state.lastExecute = snapshot.lastExecute;
    state.lastQa = snapshot.lastQa;
    state.lastFocus = snapshot.lastFocus.map((f) => ({ ...f }));
    state.needsCheck = snapshot.needsCheck;
    return state;
  }

  snapshot(): OrderStateSnapshot {
    return structuredClone({
      shopId: this.shopId,
      orderId: this.orderId,
      expected: this.expectedItems(),
      ...(this.lastExecute ? { lastExecute: this.lastExecute } : {}),
      ...(this.lastQa ? { lastQa: this.lastQa } : {}),
      lastFocus: this.lastFocus,
      needsCheck: this.needsCheck,
    });
  }

  expectedItems(): BasketItem[] {
    return [...this.expected.values()].map((item) => ({ ...item }));
  }

  // ---------- results from sub-agents ----------

  /**
   * Explore's selection becomes the expected basket of this order. A merge selection (the user added products to
   * this order) is added to it: quantities of a product already expected add up, and the basket needs a new check.
   */
  applySelection(selection: Selection, merge = false): void {
    if (merge && this.expected.size > 0) {
      for (const item of selection.items) {
        const key = normalizeName(item.name);
        const current = this.expected.get(key);
        const qty = Math.min(MAX_QTY, (current?.qty ?? 0) + item.qty);
        const sku = item.sku ?? current?.sku;
        this.expected.set(key, { name: current?.name ?? item.name, qty, ...(sku ? { sku } : {}) });
      }
      this.needsCheck = true;
      return;
    }
    this.expected.clear();
    for (const item of selection.items) this.expected.set(normalizeName(item.name), { ...item });
    this.lastExecute = undefined;
    this.lastQa = undefined;
    this.lastFocus = [];
    this.needsCheck = false;
  }

  /**
   * Successful operations update the expected basket (targetQty 0 removes the line). After a fix they also
   * define what QA re-checks: removed -> 'absent', not in the basket before -> 'present', otherwise 'quantity'.
   * An initial fill has no re-checks: QA compares the whole expected basket anyway.
   */
  applyExecuteResult(result: ExecuteResult, mode: ExecuteMode): void {
    const before = mode === 'initial' ? [] : (this.lastQa?.cart ?? this.expectedItems());
    const inBasketBefore = new Set(before.filter((line) => line.qty > 0).map((line) => normalizeName(line.name)));
    const focus: QaFocus[] = [];
    for (const op of result.ops) {
      if (op.status !== 'ok') continue;
      const key = normalizeName(op.name);
      const name = this.displayName(op.name);
      if (op.targetQty === 0) {
        this.expected.delete(key);
        focus.push({ name, check: 'absent' });
        continue;
      }
      const sku = op.sku ?? this.expected.get(key)?.sku;
      this.expected.set(key, { name, qty: op.targetQty, ...(sku ? { sku } : {}) });
      focus.push({ name, check: inBasketBefore.has(key) ? 'quantity' : 'present', expectedQty: op.targetQty });
    }
    this.lastExecute = result;
    this.lastFocus = mode === 'fix' ? focus : [];
    this.needsCheck = true;
  }

  /** The re-checks were made by this QA run: a later check (with no fix in between) has none. */
  applyQaResult(result: QaResult): void {
    this.lastQa = result;
    this.lastFocus = [];
    this.needsCheck = false;
  }

  /** The user keeps these lines as they are (qty 0 = not wanted). Returns what still differs. */
  acceptItems(items: readonly ItemQty[]): Difference[] {
    // A re-check of an accepted line would now contradict the expected basket.
    const accepted = new Set(items.map((i) => normalizeName(i.name)));
    this.lastFocus = this.lastFocus.filter((f) => !accepted.has(normalizeName(f.name)));
    for (const item of items) {
      const key = normalizeName(item.name);
      if (item.qty <= 0) {
        this.expected.delete(key);
        continue;
      }
      const sku = this.expected.get(key)?.sku;
      this.expected.set(key, { name: this.displayName(item.name), qty: item.qty, ...(sku ? { sku } : {}) });
    }
    return this.openDifferences();
  }

  /** Differences from the last QA report that the expected basket does not explain away. */
  openDifferences(): Difference[] {
    return (this.lastQa?.differences ?? []).filter((d) => this.expectedQty(d.name) !== d.actualQty);
  }

  /**
   * The last QA check is current, read the basket window the way the user sees it, nothing differs, and the order
   * form (when Execute filled one) holds the user's details.
   */
  isVerified(): boolean {
    return (
      this.lastQa !== undefined &&
      this.lastQa.modalOpened &&
      !this.needsCheck &&
      this.expected.size > 0 &&
      this.openDifferences().length === 0 &&
      (this.lastQa.orderForm === undefined || this.lastQa.orderForm.status === 'ok')
    );
  }

  // ---------- sub-agent requests ----------

  /** `merge`: the user adds products to this order (only meaningful once the order has a selection). */
  exploreSelectRequest(merge = false): ExploreRequest {
    const adding = merge && this.expected.size > 0;
    return { type: 'explore-request', action: 'select-products', shopId: this.shopId, ...(adding ? { merge: true } : {}) };
  }

  exploreUpdateRequest(add: string[], remove: string[]): ExploreRequest {
    if (add.length === 0 && remove.length === 0) throw new Error('update-product-list needs products to add or remove.');
    return { type: 'explore-request', action: 'update-product-list', shopId: this.shopId, add, remove };
  }

  /** Make the basket match the whole expected basket (absolute quantities). */
  executeInitialRequest(): ExecuteRequest {
    const ops = this.expectedItems().map((item): BasketOp => ({ name: item.name, targetQty: item.qty, ...(item.sku ? { sku: item.sku } : {}) }));
    if (ops.length === 0) throw new Error('The expected basket is empty: get a selection from the explore agent first.');
    return { type: 'execute-request', shopId: this.shopId, mode: 'initial', ops };
  }

  executeFixRequest(ops: readonly BasketOp[]): ExecuteRequest {
    if (ops.length === 0) throw new Error('A fix needs at least one operation.');
    return {
      type: 'execute-request',
      shopId: this.shopId,
      mode: 'fix',
      ops: ops.map((op) => {
        const sku = op.sku ?? this.expected.get(normalizeName(op.name))?.sku;
        return { name: this.displayName(op.name), targetQty: op.targetQty, ...(sku ? { sku } : {}) };
      }),
    };
  }

  /**
   * Expected basket plus the re-checks of the last fix, with any extra checks given (they win per product), and the
   * order form check of the last basket change.
   */
  qaRequest(extraFocus: readonly QaFocus[] = []): QaRequest {
    const focus = new Map<string, QaFocus>();
    for (const f of [...this.lastFocus, ...extraFocus]) focus.set(normalizeName(f.name), f);
    const orderForm = this.lastExecute?.orderForm;
    return {
      type: 'qa-request',
      shopId: this.shopId,
      expected: this.expectedItems(),
      focus: [...focus.values()].map((f) => ({ ...f, name: this.displayName(f.name) })),
      ...(orderForm ? { orderForm } : {}),
    };
  }

  // ---------- reporting ----------

  summary(): string {
    const lines = [`Order ${this.orderId} (shop: ${this.shopId})`];
    const items = this.expectedItems();
    lines.push(
      items.length ? `Expected basket (${items.length} lines):` : 'Expected basket: empty (nothing selected yet)',
      ...items.map((i) => `- ${i.name} × ${i.qty}`),
    );
    if (this.lastExecute) {
      const notOk = this.lastExecute.ops.filter((op) => op.status !== 'ok');
      lines.push(
        `Last basket change: ${this.lastExecute.ops.length - notOk.length}/${this.lastExecute.ops.length} operations ok` +
          (notOk.length ? `; not done: ${notOk.map((op) => `${op.name} (${op.status})`).join(', ')}` : ''),
      );
    }
    if (this.lastQa) {
      const open = this.openDifferences();
      const when = this.needsCheck ? ' (before the last change, re-check needed)' : '';
      lines.push(
        `Last QA check${when}: ${this.lastQa.verdict}` +
          (this.lastQa.modalOpened ? '' : ' (the basket window did not open; read from the browser storage)') +
          (open.length ? `; open differences: ${open.map(describeDifference).join('; ')}` : ''),
      );
    } else if (this.needsCheck) {
      lines.push('Basket not checked by QA yet.');
    }
    if (this.lastExecute?.orderForm) lines.push(describeOrderForm(this.lastExecute.orderForm));
    if (this.isVerified()) lines.push('Basket verified: ready for the final message with the cart link.');
    return lines.join('\n');
  }

  reset(): void {
    this.orderId = randomUUID();
    this.expected.clear();
    this.lastExecute = undefined;
    this.lastQa = undefined;
    this.lastFocus = [];
    this.needsCheck = false;
  }

  // ---------- internals ----------

  private expectedQty(name: string): number {
    return this.expected.get(normalizeName(name))?.qty ?? 0;
  }

  /** The canonical display name for a product the model refers to (it may differ in case/spacing). */
  private displayName(name: string): string {
    const key = normalizeName(name);
    const known = [...this.expected.values(), ...(this.lastQa?.cart ?? []), ...(this.lastExecute?.cart ?? [])];
    return known.find((item) => normalizeName(item.name) === key)?.name ?? name.trim();
  }
}

export function describeDifference(d: Difference): string {
  switch (d.kind) {
    case 'missing':
      return `${d.name}: missing (expected ${d.expectedQty})`;
    case 'extra':
      return `${d.name}: extra (${d.actualQty} in basket, not expected)`;
    case 'quantity':
      return `${d.name}: expected ${d.expectedQty}, in basket ${d.actualQty}`;
  }
}
