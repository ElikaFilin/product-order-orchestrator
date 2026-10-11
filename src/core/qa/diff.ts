/**
 * Deterministic basket check: what the user ordered vs what the basket shows.
 * The QA agent's LLM only observes the basket; this code decides the verdict.
 */
import { normalizeName, type BasketItem, type CartLine, type Difference, type QaFocus, type QaResult } from '../contracts.js';

export type FocusResult = QaResult['focus'][number];

export interface BasketDiff {
  verdict: QaResult['verdict'];
  differences: Difference[];
  focus: FocusResult[];
}

interface Tally {
  /** Display name of the first occurrence. */
  name: string;
  qty: number;
}

/** Sum quantities per normalized name, keeping first-seen order and display name. */
function tally(lines: ReadonlyArray<{ name: string; qty: number }>): Map<string, Tally> {
  const out = new Map<string, Tally>();
  for (const line of lines) {
    const key = normalizeName(line.name);
    const seen = out.get(key);
    if (seen) seen.qty += line.qty;
    else out.set(key, { name: line.name, qty: line.qty });
  }
  return out;
}

export function diffBasket(expected: readonly BasketItem[], cart: readonly CartLine[], focus: readonly QaFocus[] = []): BasketDiff {
  const want = tally(expected);
  const have = tally(cart);
  const actualOf = (key: string) => have.get(key)?.qty ?? 0;

  const differences: Difference[] = [];
  for (const [key, item] of want) {
    const actualQty = actualOf(key);
    if (actualQty === item.qty) continue;
    differences.push({ kind: actualQty === 0 ? 'missing' : 'quantity', name: item.name, expectedQty: item.qty, actualQty });
  }
  for (const [key, line] of have) {
    if (!want.has(key) && line.qty > 0) {
      differences.push({ kind: 'extra', name: line.name, expectedQty: 0, actualQty: line.qty });
    }
  }

  const focusResults = focus.map((f): FocusResult => {
    const key = normalizeName(f.name);
    const actualQty = actualOf(key);
    switch (f.check) {
      case 'quantity': {
        // Without an explicit target, "quantity" means "as in the expected basket".
        const expectedQty = f.expectedQty ?? want.get(key)?.qty ?? 0;
        return { ...f, expectedQty, actualQty, passed: actualQty === expectedQty };
      }
      case 'present':
        return { ...f, actualQty, passed: actualQty > 0 && (f.expectedQty === undefined || actualQty === f.expectedQty) };
      case 'absent':
        return { ...f, actualQty, passed: actualQty === 0 };
    }
  });

  const verdict = differences.length === 0 && focusResults.every((f) => f.passed) ? 'match' : 'mismatch';
  return { verdict, differences, focus: focusResults };
}
