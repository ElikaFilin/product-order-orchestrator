import type { HelperCall } from '../browser/guard.js';
import {
  normalizeName,
  type BasketOp,
  type CartLine,
  type CheckoutDetails,
  type ExecuteRequest,
  type ExecuteResult,
  type OrderFormCheck,
} from '../contracts.js';
import { checkOrderForm, describeOrderForm, uncheckedOrderForm } from '../order-form.js';
import { CartRead, OrderFormRead, SetQtyRead } from '../shops/helper-api.js';

type OpResult = ExecuteResult['ops'][number];
type OpStatus = OpResult['status'];

/**
 * What the shop helper returned in the page during the run (captured from the tool results), so operation
 * results and quantities come from the page rather than from the model's retelling.
 */
export class PageOps {
  private seq = 0;
  /** The last setQty per product (by the name the agent passed), with the target it asked for. */
  private readonly setQty = new Map<string, { targetQty: number; read: SetQtyRead; seq: number }>();
  private cart: { read: CartRead; seq: number } | undefined;
  /** The last fillOrderForm() or readOrderForm(). */
  private form: { read: OrderFormRead; seq: number } | undefined;

  record(call: HelperCall, value: unknown): void {
    this.seq += 1;
    const [name, qty] = call.args;
    if (call.method === 'setQty' && typeof name === 'string' && typeof qty === 'number') {
      const read = SetQtyRead.safeParse(value);
      if (read.success) this.setQty.set(normalizeName(name), { targetQty: qty, read: read.data, seq: this.seq });
    } else if (call.method === 'readCart') {
      const read = CartRead.safeParse(value);
      if (read.success) this.cart = { read: read.data, seq: this.seq };
    } else if (call.method === 'fillOrderForm' || call.method === 'readOrderForm') {
      const read = OrderFormRead.safeParse(value);
      if (read.success) this.form = { read: read.data, seq: this.seq };
    }
  }

  /** The order form as the page last showed it, checked against the user's details; only a read after every basket change counts. */
  orderForm(expected: CheckoutDetails): OrderFormCheck {
    if (!this.form) return uncheckedOrderForm('The order form was not filled.');
    if (this.form.seq < this.lastChange()) return uncheckedOrderForm('The basket changed after the order form was last read.');
    return checkOrderForm(expected, this.form.read);
  }

  private lastChange(): number {
    return Math.max(0, ...[...this.setQty.values()].map((d) => d.seq));
  }

  /** The page's result for a requested operation: its last setQty call with the same name and target. */
  resultFor(op: BasketOp): { status: Exclude<OpStatus, 'skipped'>; actualQty: number; detail?: string } | undefined {
    const done = this.setQty.get(normalizeName(op.name));
    if (!done || done.targetQty !== op.targetQty) return undefined;
    // A basket read after the change is the final word on the quantity.
    const actualQty =
      this.cart && this.cart.seq > done.seq
        ? this.cart.read.lines.filter((l) => normalizeName(l.name) === normalizeName(done.read.name)).reduce((sum, l) => sum + l.qty, 0)
        : done.read.after;
    return { status: done.read.status, actualQty, ...(done.read.detail ? { detail: done.read.detail } : {}) };
  }

  /** Products not in `ops` that the page removed from the basket (setQty to 0 from a non-empty line). */
  removedExcept(ops: readonly BasketOp[]): string[] {
    const requested = new Set(ops.map((op) => normalizeName(op.name)));
    return [...this.setQty.entries()]
      .filter(([key, d]) => !requested.has(key) && d.targetQty === 0 && d.read.status === 'ok' && d.read.before > 0)
      .map(([, d]) => d.read.name);
  }

  /** The basket from the last read that came after every change, if there was one. */
  finalCart(): CartLine[] | undefined {
    if (!this.cart || this.cart.seq < this.lastChange()) return undefined;
    return this.cart.read.lines.map((l) => ({
      name: l.name,
      qty: l.qty,
      ...(typeof l.unitPrice === 'number' ? { unitPrice: l.unitPrice } : {}),
      ...(typeof l.amount === 'number' ? { amount: l.amount } : {}),
      ...(l.sku ? { sku: l.sku } : {}),
    }));
  }
}

/**
 * Make the agent's report safe to act on: ids come from the request and the shop, every requested op appears
 * exactly once in request order, results the page returned win over the model's report, and "ok" is only
 * kept when the read-back quantity agrees. With `checkout`, the order form is checked from the page data only.
 */
export function finalizeExecuteResult(
  request: ExecuteRequest,
  reported: ExecuteResult,
  cartUrl: string,
  page?: PageOps,
  checkout?: CheckoutDetails,
): ExecuteResult {
  const reportedByName = new Map<string, OpResult>();
  for (const op of reported.ops) {
    const key = normalizeName(op.name);
    if (!reportedByName.has(key)) reportedByName.set(key, op);
  }
  const requested = new Set(request.ops.map((op) => normalizeName(op.name)));
  const unrequested = reported.ops.filter((op) => !requested.has(normalizeName(op.name))).map((op) => op.name);
  const cleared = request.clearBasket && page ? page.removedExcept(request.ops) : [];
  const notes = [
    reported.notes?.trim(),
    // Clearing a new order's basket reports lines of earlier orders; those are expected.
    unrequested.length && !request.clearBasket ? `Reported operations that were not requested: ${unrequested.join('; ')}.` : undefined,
  ].filter((n): n is string => Boolean(n));

  return {
    type: 'execute-result',
    shopId: request.shopId,
    cartUrl,
    ops: request.ops.map((op) => reconcile(op, page?.resultFor(op) ?? reportedByName.get(normalizeName(op.name)))),
    cart: page?.finalCart() ?? reported.cart,
    ...(cleared.length ? { cleared } : {}),
    ...(checkout ? { orderForm: page ? page.orderForm(checkout) : uncheckedOrderForm('The page data was not captured.') } : {}),
    ...(notes.length ? { notes: notes.join(' ') } : {}),
  };
}

function reconcile(op: BasketOp, reported: Pick<OpResult, 'status' | 'actualQty' | 'detail'> | undefined): OpResult {
  const base = { name: op.name, targetQty: op.targetQty, ...(op.sku ? { sku: op.sku } : {}) };
  if (!reported) return { ...base, status: 'skipped', detail: 'The agent did not report this operation.' };
  const { status, actualQty, detail } = reported;
  if (status === 'ok' && actualQty !== undefined && actualQty !== op.targetQty) {
    const why = `Reported ok, but the basket shows ${actualQty}.`;
    return { ...base, status: 'failed', actualQty, detail: detail ? `${why} ${detail}` : why };
  }
  return { ...base, status, ...(actualQty !== undefined ? { actualQty } : {}), ...(detail ? { detail } : {}) };
}

const STATUS_TEXT: Record<OpStatus, string> = {
  ok: 'ok',
  not_found: 'not found',
  failed: 'failed',
  skipped: 'skipped',
};

/** `clearBasket`: the request cleared the basket first (a new order), so any line outside its operations is left over. */
export function summarizeExecute(mode: ExecuteRequest['mode'], result: ExecuteResult, clearBasket = false): string {
  const count = (status: OpStatus) => result.ops.filter((op) => op.status === status).length;
  const skipped = count('skipped');
  const counts = `${count('ok')} ok, ${count('not_found')} not found, ${count('failed')} failed${skipped ? `, ${skipped} skipped` : ''}`;
  const problems = result.ops
    .filter((op) => op.status !== 'ok')
    .map((op) => {
      const basket = op.actualQty === undefined ? '' : `, basket has ${op.actualQty}`;
      return `- ${op.name} (target ${op.targetQty}): ${STATUS_TEXT[op.status]}${basket}${op.detail ? ` — ${op.detail}` : ''}`;
    });
  const lines = result.cart.filter((line) => line.qty > 0);
  const units = lines.reduce((sum, line) => sum + line.qty, 0);
  const requested = new Set(result.ops.map((op) => normalizeName(op.name)));
  const leftovers = clearBasket ? lines.filter((line) => !requested.has(normalizeName(line.name))).map((line) => line.name) : [];
  return [
    `Basket ${mode === 'fix' ? 'fix' : 'fill'} finished: ${counts}.`,
    ...(result.cleared?.length ? [`Cleared first (lines of earlier orders): ${result.cleared.join('; ')}.`] : []),
    ...(leftovers.length ? [`Not cleared (still in the basket, not in this order): ${leftovers.join('; ')}.`] : []),
    ...problems,
    `Basket now: ${lines.length} line(s), ${units} unit(s).`,
    ...(result.orderForm ? [describeOrderForm(result.orderForm)] : []),
  ].join('\n');
}
