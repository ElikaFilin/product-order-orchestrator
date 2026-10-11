import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { readOnlyBasketGuard } from '../src/core/qa/guard.js';
import { PageReads, QaObservation, summarizeQa, toQaResult } from '../src/core/qa/report.js';
import { buildQaPrompt, resolveQaRequest } from '../src/core/qa/request.js';
import { QaResult, type CartLine, type QaRequest } from '../src/core/contracts.js';
import { karashynyard } from '../src/core/shops/karashynyard/index.js';
import { AgentTaskError } from '../src/core/errors.js';

const FILLET = 'Філе зі стегна індички, 1 кг';
const LIVER = 'Печінка індички, 500 г';
const EGGS = 'Курячі яйця від фермерських курей, 10 шт';
const CART_URL = 'https://karashynyard.com.ua/#opencart';
const SHOP = { name: 'Karashyn Yard', baseUrl: 'https://karashynyard.com.ua/' };

const qaRequest = (expected: QaRequest['expected'], focus: QaRequest['focus'] = []): QaRequest => ({
  type: 'qa-request',
  shopId: 'karashynyard',
  expected,
  focus,
});

const observation = (o: Partial<QaObservation> = {}): QaObservation =>
  QaObservation.parse({ modalOpened: true, readVia: 'both', lines: [], total: null, ...o });

const PASTE = 'Горіхова паста з фунндуком 350 г';

/** Page data as the helper returned it: the open basket window and the stored basket with the same lines. */
function pageWith(lines: CartLine[], opts: { modalOpen?: boolean; total?: number } = {}): PageReads {
  const page = new PageReads();
  const total = opts.total ?? lines.reduce((sum, l) => sum + (l.amount ?? 0), 0);
  page.record('readModal', { open: opts.modalOpen ?? true, lines: lines.map((l) => ({ name: l.name, qty: l.qty, amount: l.amount ?? null })), total });
  page.record('readCart', { lines: lines.map((l) => ({ ...l, unitPrice: l.unitPrice ?? 0, amount: l.amount ?? 0, sku: l.sku ?? '' })), units: 0, total });
  return page;
}

describe('resolveQaRequest', () => {
  it('uses a qa-request payload and defaults focus to empty', () => {
    const payload = { type: 'qa-request', shopId: 'karashynyard', expected: [{ name: FILLET, qty: 2 }] };
    expect(resolveQaRequest([{ type: 'execute-result' }, payload])).toEqual({ ...payload, focus: [] });
  });

  it('builds the expected basket from a forwarded selection', () => {
    const selection = { type: 'selection', shopId: 'karashynyard', items: [{ name: FILLET, qty: 2, sku: '1' }] };
    expect(resolveQaRequest([selection])).toEqual(qaRequest([{ name: FILLET, qty: 2, sku: '1' }]));
  });

  it('prefers the qa-request over a selection', () => {
    const selection = { type: 'selection', shopId: 'karashynyard', items: [{ name: FILLET, qty: 2 }] };
    const payload = qaRequest([{ name: LIVER, qty: 1 }], [{ name: FILLET, check: 'absent' }]);
    expect(resolveQaRequest([selection, payload])).toEqual(payload);
  });

  it('rejects a message without a usable payload', () => {
    expect(() => resolveQaRequest([{ type: 'qa-request' }])).toThrow(AgentTaskError);
  });
});

describe('buildQaPrompt', () => {
  it('lists the expected basket and phrases every focus check', () => {
    const prompt = buildQaPrompt(
      qaRequest(
        [
          { name: FILLET, qty: 2 },
          { name: LIVER, qty: 1 },
        ],
        [
          { name: FILLET, check: 'quantity', expectedQty: 2 },
          { name: LIVER, check: 'present' },
          { name: EGGS, check: 'absent' },
        ],
      ),
      SHOP,
      'Re-check after removing eggs.',
    );
    expect(prompt).toContain('2 line(s), 3 unit(s)');
    expect(prompt).toContain(`1. ${FILLET} — 2`);
    expect(prompt).toContain(JSON.stringify([{ name: FILLET, qty: 2 }, { name: LIVER, qty: 1 }]));
    expect(prompt).toContain(`- "${FILLET}": quantity must now be 2`);
    expect(prompt).toContain(`- "${LIVER}": must be in the basket`);
    expect(prompt).toContain(`- "${EGGS}": must no longer be in the basket`);
    expect(prompt).toContain('Instruction from the Chief of Staff:\nRe-check after removing eggs.');
    expect(prompt).toContain('Never change the basket.');
  });

  it('says the basket should be empty when nothing is expected, and skips empty sections', () => {
    const prompt = buildQaPrompt(qaRequest([]), SHOP, '');
    expect(prompt).toContain('should have no lines');
    expect(prompt).not.toContain('extra care');
    expect(prompt).not.toContain('Chief of Staff');
  });
});

describe('QaObservation', () => {
  it('converts to a JSON schema for the structured output', () => {
    const schema = z.toJSONSchema(QaObservation) as { required?: string[] };
    expect(schema.required).toEqual(expect.arrayContaining(['modalOpened', 'readVia', 'lines', 'total']));
  });
});

describe('toQaResult', () => {
  it('computes the verdict in code from the page data, whatever the observation says', () => {
    const req = qaRequest([{ name: FILLET, qty: 2 }], [{ name: EGGS, check: 'absent' }]);
    const page = pageWith([
      { name: FILLET, qty: 1, amount: 665, unitPrice: 665, sku: '1' },
      { name: EGGS, qty: 1, amount: 180, unitPrice: 180, sku: '55' },
    ]);
    const result = toQaResult(
      req,
      observation({ lines: [{ name: FILLET, qty: 1 }, { name: EGGS, qty: 1 }], total: 845, notes: 'All good!' }),
      CART_URL,
      page,
    );
    expect(result).toEqual({
      type: 'qa-result',
      shopId: 'karashynyard',
      verdict: 'mismatch',
      modalOpened: true,
      cart: [
        { name: FILLET, qty: 1, unitPrice: 665, amount: 665, sku: '1' },
        { name: EGGS, qty: 1, unitPrice: 180, amount: 180, sku: '55' },
      ],
      total: 845,
      differences: [
        { kind: 'quantity', name: FILLET, expectedQty: 2, actualQty: 1 },
        { kind: 'extra', name: EGGS, expectedQty: 0, actualQty: 1 },
      ],
      focus: [{ name: EGGS, check: 'absent', actualQty: 1, passed: false }],
      cartUrl: CART_URL,
      notes: 'All good!',
    });
    expect(QaResult.parse(result)).toEqual(result);
  });

  it("is not fooled by a name the QA model retyped: the shop's own spelling decides", () => {
    const req = qaRequest([{ name: PASTE, qty: 1 }]);
    const retyped = observation({ lines: [{ name: 'Горіхова паста з фундуком 350 г', qty: 1 }] });
    const result = toQaResult(req, retyped, CART_URL, pageWith([{ name: PASTE, qty: 1, amount: 850 }]));
    expect(result.verdict).toBe('match');
    expect(result.differences).toEqual([]);
    expect(result.notes).toMatch(/report differs from the page data/);
  });

  it('is not fooled by a near-duplicate line the QA model relabelled as the expected product', () => {
    const req = qaRequest([{ name: 'Котлети по-київськи з індички, 900 г', qty: 1 }]);
    const relabelled = observation({ lines: [{ name: 'Котлети по-київськи з індички, 900 г', qty: 1 }] });
    const page = pageWith([{ name: 'Котлети по-київськи з фермерської індички, 0,9 кг', qty: 1, amount: 700 }]);
    expect(toQaResult(req, relabelled, CART_URL, page).verdict).toBe('mismatch');
  });

  it('uses the stored basket when the window never opened, and says so', () => {
    const page = new PageReads();
    page.record('readModal', { open: false, lines: [], total: null });
    page.record('readCart', { lines: [{ name: FILLET, qty: 2, unitPrice: 665, amount: 1330, sku: '1' }], units: 2, total: 1330 });
    const result = toQaResult(qaRequest([{ name: FILLET, qty: 2 }]), observation({ modalOpened: true }), CART_URL, page);
    expect(result).toMatchObject({ verdict: 'match', modalOpened: false, total: 1330, cart: [{ name: FILLET, qty: 2 }] });
    expect(result.notes).toMatch(/^The basket window could not be opened/);
  });

  it('notes when the window and the stored basket disagree, and trusts the window', () => {
    const page = new PageReads();
    page.record('readModal', { open: true, lines: [{ name: FILLET, qty: 2, amount: 1330 }], total: 1330 });
    page.record('readCart', { lines: [{ name: FILLET, qty: 3, unitPrice: 665, amount: 1995, sku: '1' }], units: 3, total: 1995 });
    const result = toQaResult(qaRequest([{ name: FILLET, qty: 2 }]), observation({ lines: [{ name: FILLET, qty: 2 }] }), CART_URL, page);
    expect(result.verdict).toBe('match');
    expect(result.notes).toContain('window and the stored basket disagree');
  });

  it("falls back to the model's report when no page data was captured, and says so", () => {
    const result = toQaResult(qaRequest([{ name: FILLET, qty: 2 }]), observation({ lines: [{ name: FILLET, qty: 2 }] }), CART_URL);
    expect(result).toMatchObject({ verdict: 'match', modalOpened: true });
    expect(result).not.toHaveProperty('total');
    expect(result.notes).toBe('The page data was not captured; the lines are as the QA model reported them.');

    const fromStorage = toQaResult(qaRequest([]), observation({ modalOpened: false, readVia: 'storage', notes: 'Icon missing.' }), CART_URL);
    expect(fromStorage.modalOpened).toBe(false);
    expect(fromStorage.notes).toBe(
      'The page data was not captured; the lines are as the QA model reported them. ' +
        'The basket window could not be opened; the lines were read from the browser storage. Icon missing.',
    );
  });

  it('ignores page results that do not look like the helper', () => {
    const page = new PageReads();
    page.record('readModal', 'Error: not on the shop');
    page.record('readCart', { lines: 'nope' });
    page.record('status', { ready: true });
    expect(page.modal).toBeUndefined();
    expect(page.cart).toBeUndefined();
  });
});

describe('summarizeQa', () => {
  it('says the basket matches with the line count', () => {
    const result = toQaResult(qaRequest([{ name: FILLET, qty: 2 }]), observation({ lines: [{ name: FILLET, qty: 2 }] }), CART_URL, pageWith([{ name: FILLET, qty: 2 }]));
    expect(summarizeQa(result)).toBe('Basket matches (1 line).');
  });

  it('says when a match was read from the storage only, and adds the notes', () => {
    const page = new PageReads();
    page.record('readCart', { lines: [{ name: FILLET, qty: 2 }], total: 0 });
    const result = toQaResult(qaRequest([{ name: FILLET, qty: 2 }]), observation({ lines: [{ name: FILLET, qty: 2 }], modalOpened: false }), CART_URL, page);
    expect(summarizeQa(result)).toBe(
      'Basket matches (1 line, read from the browser storage only).\nNotes: The basket window could not be opened; the lines were read from the browser storage.',
    );
  });

  it('lists every difference and failed checks not already listed', () => {
    const req = qaRequest(
      [
        { name: FILLET, qty: 2 },
        { name: LIVER, qty: 1 },
      ],
      [
        { name: FILLET, check: 'quantity', expectedQty: 2 },
        { name: 'Мед, 1 л', check: 'present', expectedQty: 1 },
      ],
    );
    const lines = [{ name: FILLET, qty: 3 }, { name: EGGS, qty: 1 }];
    const result = toQaResult(req, observation({ lines }), CART_URL, pageWith(lines));
    expect(summarizeQa(result)).toBe(
      [
        'Basket differs from the order:',
        `- wrong quantity: ${FILLET}: expected 2, basket has 3`,
        `- missing: ${LIVER} ×1`,
        `- extra: ${EGGS} ×1`,
        '- check failed: Мед, 1 л should be ×1, basket has 0',
      ].join('\n'),
    );
  });

  it('explains a failed absent check', () => {
    const lines = [{ name: EGGS, qty: 1 }];
    const result = toQaResult(qaRequest([{ name: EGGS, qty: 1 }], [{ name: EGGS, check: 'absent' }]), observation({ lines }), CART_URL, pageWith(lines));
    expect(summarizeQa(result)).toBe(`Basket differs from the order:\n- check failed: ${EGGS} should be absent, basket has 1`);
  });
});

describe('readOnlyBasketGuard', () => {
  const toolset = {
    evalTool: { name: 'playwright__browser_evaluate', codeField: 'function' as const },
    clickTool: { name: 'playwright__browser_click', selectorField: 'target' as const },
  };

  it('denies page scripts that change the basket or are not one read call of the helper', () => {
    const shopGuard = vi.fn(() => undefined);
    const guard = readOnlyBasketGuard(toolset, karashynyard, shopGuard);
    for (const script of [
      "await __poo.setQty('Філе', 2)",
      'window.__poo.setQty ("x", 0)',
      "window.__poo['set' + 'Qty']('x', 0)",
      "localStorage.setItem('tcart', '{}')",
      'localStorage.clear()',
      'return [__poo.readModal(), __poo.readCart(), localStorage.getItem("tcart")]',
      'var f = document.querySelector(".t706__cartwin form"); f.querySelector("button").click()',
    ]) {
      expect(guard(toolset.evalTool.name, { function: script })?.deny, script).toMatch(/read-only/);
    }
    expect(shopGuard).not.toHaveBeenCalled();
  });

  it('denies every click except the basket icon', () => {
    const shopGuard = vi.fn(() => undefined);
    const guard = readOnlyBasketGuard(toolset, karashynyard, shopGuard);
    for (const selector of ['@e47', '.t706__product-del', '.t706__product-plus', 'button[type=button]', '.t706__cartwin .t-submit']) {
      expect(guard(toolset.clickTool.name, { target: selector })?.deny, selector).toMatch(/only click the basket icon/);
    }
    expect(guard(toolset.clickTool.name, {})?.deny).toMatch(/only click the basket icon/);
    expect(shopGuard).not.toHaveBeenCalled();
  });

  it('defers read calls, basket-icon clicks and other tools to the shop guard', () => {
    const shopGuard = vi.fn((tool: string) => (tool.endsWith('snapshot') ? { deny: 'checkout' } : undefined));
    const guard = readOnlyBasketGuard(toolset, karashynyard, shopGuard);
    expect(guard(toolset.evalTool.name, { function: '() => window.__poo.readModal()' })).toBeUndefined();
    expect(guard(toolset.evalTool.name, { function: 'window.__poo.status()' })).toBeUndefined();
    expect(guard(toolset.clickTool.name, { target: '.t706__carticon-wrapper' })).toBeUndefined();
    expect(guard(toolset.clickTool.name, { target: 'a.t-menuwidgeticons__link_cart' })).toBeUndefined();
    expect(guard('playwright__browser_snapshot', { target: '.t706__orderform' })).toEqual({ deny: 'checkout' });
    expect(shopGuard).toHaveBeenCalledTimes(5);
  });
});
