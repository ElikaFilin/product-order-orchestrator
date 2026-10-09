import { z } from 'zod';
import { CartLine, normalizeName, type Difference, type QaRequest, type QaResult } from '../../shared/contracts.js';
import { CartRead, ModalRead } from '../../shops/helper-api.js';
import { diffBasket, type FocusResult } from './diff.js';

/** What the QA LLM saw in the browser. It reports facts only; the verdict is computed in code. */
export const QaObservation = z.object({
  modalOpened: z.boolean().describe('True if the cart window (basket modal) was opened and read.'),
  readVia: z
    .enum(['modal', 'storage', 'both'])
    .describe("Where `lines` come from: the cart window, the shop's browser storage, or both (cross-checked)."),
  lines: z.array(CartLine).describe('Every line in the basket: name exactly as shown, quantity, and price/amount/sku when known.'),
  total: z.number().nonnegative().nullable().describe('Basket total as shown in the cart window, null if not visible.'),
  notes: z.string().optional().describe('Anything unusual: cart window vs storage disagreement, popups, errors.'),
});
export type QaObservation = z.infer<typeof QaObservation>;

/**
 * What the shop helper returned in the page during the run (captured from the tool results). The verdict is
 * computed from these, so a name the model retyped or "corrected" cannot create or hide a difference.
 */
export class PageReads {
  /** The last readModal() that saw the basket window open. */
  modal: ModalRead | undefined;
  /** The last readCart() (the stored basket). */
  cart: CartRead | undefined;

  record(method: string, value: unknown): void {
    if (method === 'readModal') {
      const read = ModalRead.safeParse(value);
      if (read.success && read.data.open) this.modal = read.data;
    } else if (method === 'readCart') {
      const read = CartRead.safeParse(value);
      if (read.success) this.cart = read.data;
    }
  }
}

const STORAGE_ONLY = 'The basket window could not be opened; the lines were read from the browser storage.';

interface BasketSeen {
  lines: CartLine[];
  modalOpened: boolean;
  total: number | null;
  notes: string[];
}

export function toQaResult(request: QaRequest, observation: QaObservation, cartUrl: string, page?: PageReads): QaResult {
  const seen = basketSeen(observation, page);
  const diff = diffBasket(request.expected, seen.lines, request.focus);
  const notes = [...seen.notes, observation.notes?.trim()].filter((n): n is string => Boolean(n));
  return {
    type: 'qa-result',
    shopId: request.shopId,
    verdict: diff.verdict,
    modalOpened: seen.modalOpened,
    cart: seen.lines,
    ...(seen.total === null ? {} : { total: seen.total }),
    differences: diff.differences,
    focus: diff.focus,
    cartUrl,
    ...(notes.length ? { notes: notes.join(' ') } : {}),
  };
}

/** The basket as the page showed it: the open window first, else the stored basket, else the model's report. */
function basketSeen(observation: QaObservation, page: PageReads | undefined): BasketSeen {
  if (!page?.modal && !page?.cart) {
    return {
      lines: observation.lines,
      modalOpened: observation.modalOpened,
      total: observation.total,
      notes: ['The page data was not captured; the lines are as the QA model reported them.', ...(observation.modalOpened ? [] : [STORAGE_ONLY])],
    };
  }
  const stored = new Map((page.cart?.lines ?? []).map((l) => [normalizeName(l.name), l]));
  const lines = page.modal
    ? page.modal.lines.map((l) => {
        const s = stored.get(normalizeName(l.name));
        return cartLine({ name: l.name, qty: l.qty, amount: l.amount ?? s?.amount, unitPrice: s?.unitPrice, sku: s?.sku });
      })
    : page.cart!.lines.map(cartLine);
  const notes: string[] = [];
  if (!page.modal) notes.push(STORAGE_ONLY);
  if (page.modal && page.cart && !sameBasket(page.modal.lines, page.cart.lines)) {
    notes.push('The basket window and the stored basket disagree; the window was used.');
  }
  if (!sameBasket(lines, observation.lines)) notes.push("The QA model's report differs from the page data; the page data was used.");
  const total = page.modal ? (page.modal.total ?? null) : (page.cart?.total ?? null);
  return { lines, modalOpened: Boolean(page.modal), total, notes };
}

function cartLine(l: { name: string; qty: number; unitPrice?: number | undefined; amount?: number | null | undefined; sku?: string | undefined }): CartLine {
  return {
    name: l.name,
    qty: l.qty,
    ...(typeof l.unitPrice === 'number' ? { unitPrice: l.unitPrice } : {}),
    ...(typeof l.amount === 'number' ? { amount: l.amount } : {}),
    ...(l.sku ? { sku: l.sku } : {}),
  };
}

function sameBasket(a: ReadonlyArray<{ name: string; qty: number }>, b: ReadonlyArray<{ name: string; qty: number }>): boolean {
  const tally = (lines: ReadonlyArray<{ name: string; qty: number }>) => {
    const out = new Map<string, number>();
    for (const l of lines) if (l.qty > 0) out.set(normalizeName(l.name), (out.get(normalizeName(l.name)) ?? 0) + l.qty);
    return [...out.entries()].sort(([x], [y]) => x.localeCompare(y)).join('|');
  };
  return tally(a) === tally(b);
}

function describeDifference(d: Difference): string {
  switch (d.kind) {
    case 'missing':
      return `missing: ${d.name} ×${d.expectedQty}`;
    case 'extra':
      return `extra: ${d.name} ×${d.actualQty}`;
    case 'quantity':
      return `wrong quantity: ${d.name}: expected ${d.expectedQty}, basket has ${d.actualQty}`;
  }
}

function describeFailedCheck(f: FocusResult): string {
  const want = f.check === 'absent' ? 'absent' : f.expectedQty === undefined ? 'present' : `×${f.expectedQty}`;
  return `check failed: ${f.name} should be ${want}, basket has ${f.actualQty}`;
}

export function summarizeQa(result: QaResult): string {
  const notes = result.notes ? [`Notes: ${result.notes}`] : [];
  if (result.verdict === 'match') {
    const lines = result.cart.filter((l) => l.qty > 0).length;
    const where = result.modalOpened ? '' : ', read from the browser storage only';
    return [`Basket matches (${lines} line${lines === 1 ? '' : 's'}${where}).`, ...notes].join('\n');
  }
  // A failed focus check usually repeats a difference for the same product; list it only once.
  const listed = new Set(result.differences.map((d) => normalizeName(d.name)));
  const items = [
    ...result.differences.map(describeDifference),
    ...result.focus.filter((f) => !f.passed && !listed.has(normalizeName(f.name))).map(describeFailedCheck),
  ];
  return ['Basket differs from the order:', ...items.map((s) => `- ${s}`), ...notes].join('\n');
}
