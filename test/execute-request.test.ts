import { describe, expect, it } from 'vitest';
import { buildExecutePrompt, resolveExecuteRequest } from '../src/core/execute/request.js';
import { finalizeExecuteResult, PageOps, summarizeExecute } from '../src/core/execute/result.js';
import { parseHelperCall } from '../src/core/browser/guard.js';
import { ExecuteResult, type ExecuteRequest } from '../src/core/contracts.js';
import { AgentTaskError } from '../src/core/errors.js';

const FILLET = 'Філе зі стегна індички, 1 кг';
const LIVER = 'Печінка індички, 500 г';
const EGGS = 'Курячі яйця від фермерських курей, 10 шт';
const CART_URL = 'https://karashynyard.com.ua/#opencart';
const SHOP = { id: 'karashynyard', name: 'Karashyn Yard', baseUrl: 'https://karashynyard.com.ua/', cartUrl: CART_URL };

const request = (ops: ExecuteRequest['ops'], mode: ExecuteRequest['mode'] = 'initial'): ExecuteRequest => ({
  type: 'execute-request',
  shopId: 'karashynyard',
  mode,
  ops,
});

/** A report as the LLM might return it, validated by the same schema runAgent uses. */
const report = (r: Partial<ExecuteResult> & Pick<ExecuteResult, 'ops'>): ExecuteResult =>
  ExecuteResult.parse({ type: 'execute-result', shopId: 'whatever', cartUrl: 'https://example.com/', cart: [], ...r });

describe('resolveExecuteRequest', () => {
  it('uses an execute-request payload as is', () => {
    const payload = request([{ name: FILLET, targetQty: 0 }], 'fix');
    expect(resolveExecuteRequest([{ type: 'note' }, payload])).toEqual(payload);
  });

  it('prefers the execute-request over a forwarded selection', () => {
    const payload = request([{ name: LIVER, targetQty: 2 }], 'fix');
    const selection = { type: 'selection', shopId: 'karashynyard', items: [{ name: FILLET, qty: 1 }] };
    expect(resolveExecuteRequest([selection, payload])).toEqual(payload);
  });

  it('builds an initial request from a forwarded selection', () => {
    const selection = {
      type: 'selection',
      shopId: 'karashynyard',
      items: [
        { name: FILLET, qty: 2, sku: '1' },
        { name: LIVER, qty: 1 },
      ],
    };
    expect(resolveExecuteRequest([selection])).toEqual({
      type: 'execute-request',
      shopId: 'karashynyard',
      mode: 'initial',
      ops: [
        { name: FILLET, targetQty: 2, sku: '1' },
        { name: LIVER, targetQty: 1 },
      ],
    });
  });

  it('sums selection lines for the same product (ops are absolute)', () => {
    const selection = {
      type: 'selection',
      shopId: 'karashynyard',
      items: [
        { name: FILLET, qty: 1 },
        { name: LIVER, qty: 1 },
        { name: ` ${FILLET.toUpperCase()}`, qty: 2 },
      ],
    };
    expect(resolveExecuteRequest([selection]).ops).toEqual([
      { name: FILLET, targetQty: 3 },
      { name: LIVER, targetQty: 1 },
    ]);
  });

  it('rejects a message without a usable payload', () => {
    const invalid = [[], [{ type: 'execute-request', shopId: 'karashynyard', mode: 'initial', ops: [] }], [{ type: 'selection', items: [] }]];
    for (const data of invalid) {
      expect(() => resolveExecuteRequest(data)).toThrow(AgentTaskError);
      try {
        resolveExecuteRequest(data);
      } catch (err) {
        expect((err as AgentTaskError).code).toBe('INVALID_REQUEST');
      }
    }
  });
});

describe('buildExecutePrompt', () => {
  it('lists the ops numbered, as JSON, with the mode, the shop and the COS instruction', () => {
    const req = request([
      { name: FILLET, targetQty: 2 },
      { name: EGGS, targetQty: 0 },
    ], 'fix');
    const prompt = buildExecutePrompt(req, SHOP, '  Please hurry.  ');
    expect(prompt).toContain(`1. ${FILLET} — quantity 2`);
    expect(prompt).toContain(`2. ${EGGS} — remove from the basket`);
    expect(prompt).toContain(JSON.stringify(req.ops));
    expect(prompt).toContain('Mode: fix');
    expect(prompt).toContain('https://karashynyard.com.ua/');
    expect(prompt).toContain('call poo_submit_execute');
    expect(prompt).toContain('Instruction from the Chief of Staff:\nPlease hurry.');
  });

  it('omits the instruction block when COS sent no text', () => {
    expect(buildExecutePrompt(request([{ name: FILLET, targetQty: 1 }]), SHOP, '  ')).not.toContain('Chief of Staff');
  });
});

describe('finalizeExecuteResult', () => {
  it('forces shopId and cartUrl from the request and the shop', () => {
    const req = request([{ name: FILLET, targetQty: 2 }]);
    const result = finalizeExecuteResult(req, report({ ops: [{ name: FILLET, targetQty: 2, status: 'ok', actualQty: 2 }] }), CART_URL);
    expect(result).toMatchObject({ type: 'execute-result', shopId: 'karashynyard', cartUrl: CART_URL });
    expect(ExecuteResult.parse(result)).toEqual(result);
  });

  it('adds every requested op the agent did not report as skipped, in request order', () => {
    const req = request([
      { name: FILLET, targetQty: 2 },
      { name: LIVER, targetQty: 1, sku: '4' },
      { name: EGGS, targetQty: 0 },
    ]);
    const result = finalizeExecuteResult(req, report({ ops: [{ name: EGGS, targetQty: 0, status: 'ok', actualQty: 0 }] }), CART_URL);
    expect(result.ops).toEqual([
      { name: FILLET, targetQty: 2, status: 'skipped', detail: 'The agent did not report this operation.' },
      { name: LIVER, targetQty: 1, sku: '4', status: 'skipped', detail: 'The agent did not report this operation.' },
      { name: EGGS, targetQty: 0, status: 'ok', actualQty: 0 },
    ]);
  });

  it('matches reported ops by normalized name and keeps the requested name and target', () => {
    const req = request([{ name: "Пиріжки з м'ясом", targetQty: 2 }]);
    const reported = report({ ops: [{ name: 'пиріжки з м’ясом ', targetQty: 3, status: 'ok', actualQty: 2 }] });
    expect(finalizeExecuteResult(req, reported, CART_URL).ops).toEqual([
      { name: "Пиріжки з м'ясом", targetQty: 2, status: 'ok', actualQty: 2 },
    ]);
  });

  it('keeps not_found / failed details from the agent', () => {
    const req = request([
      { name: 'Масло ГХІ, 330 г', targetQty: 1 },
      { name: FILLET, targetQty: 2 },
    ]);
    const reported = report({
      ops: [
        { name: 'Масло ГХІ, 330 г', targetQty: 1, status: 'not_found', detail: 'candidates: Масло ГХІ, 470 мл' },
        { name: FILLET, targetQty: 2, status: 'failed', actualQty: 1, detail: 'cart window did not open' },
      ],
    });
    expect(finalizeExecuteResult(req, reported, CART_URL).ops).toEqual([
      { name: 'Масло ГХІ, 330 г', targetQty: 1, status: 'not_found', detail: 'candidates: Масло ГХІ, 470 мл' },
      { name: FILLET, targetQty: 2, status: 'failed', actualQty: 1, detail: 'cart window did not open' },
    ]);
  });

  it('downgrades "ok" to failed when the read-back quantity is not the target', () => {
    const req = request([{ name: FILLET, targetQty: 2 }]);
    const reported = report({ ops: [{ name: FILLET, targetQty: 2, status: 'ok', actualQty: 4 }] });
    expect(finalizeExecuteResult(req, reported, CART_URL).ops[0]).toEqual({
      name: FILLET,
      targetQty: 2,
      status: 'failed',
      actualQty: 4,
      detail: 'Reported ok, but the basket shows 4.',
    });
  });

  it('uses the first report for a product and notes ops that were not requested', () => {
    const req = request([{ name: FILLET, targetQty: 1 }]);
    const reported = report({
      ops: [
        { name: FILLET, targetQty: 1, status: 'ok', actualQty: 1 },
        { name: FILLET, targetQty: 1, status: 'failed' },
        { name: EGGS, targetQty: 1, status: 'ok', actualQty: 1 },
      ],
      notes: 'Basket already had eggs.',
    });
    const result = finalizeExecuteResult(req, reported, CART_URL);
    expect(result.ops).toEqual([{ name: FILLET, targetQty: 1, status: 'ok', actualQty: 1 }]);
    expect(result.notes).toBe(`Basket already had eggs. Reported operations that were not requested: ${EGGS}.`);
  });

  it('passes the basket lines through', () => {
    const cart = [{ name: FILLET, qty: 2, unitPrice: 665, amount: 1330, sku: '1' }];
    const result = finalizeExecuteResult(request([{ name: FILLET, targetQty: 2 }]), report({ ops: [], cart }), CART_URL);
    expect(result.cart).toEqual(cart);
    expect(result.notes).toBeUndefined();
  });
});

describe('finalizeExecuteResult with page data', () => {
  const PASTE = 'Горіхова паста з фунндуком 350 г';
  /** What the agent's page scripts returned, in call order. */
  function pageOf(calls: Array<[string, unknown]>): PageOps {
    const page = new PageOps();
    for (const [code, value] of calls) page.record(parseHelperCall(code)!, value);
    return page;
  }

  it("takes each operation's status and quantity from the page, not from the model's retelling", () => {
    const req = request([
      { name: PASTE, targetQty: 1 },
      { name: FILLET, targetQty: 2 },
    ]);
    const page = pageOf([
      ['window.__poo.readCart()', { lines: [], units: 0, total: 0 }],
      [`window.__poo.setQty(${JSON.stringify(PASTE)}, 1)`, { status: 'ok', name: PASTE, before: 0, after: 1 }],
      [`window.__poo.setQty(${JSON.stringify(FILLET)}, 2)`, { status: 'failed', name: FILLET, before: 0, after: 1, detail: 'Tilda did not add the product' }],
      ['window.__poo.readCart()', { lines: [{ name: PASTE, qty: 1, unitPrice: 850, amount: 850, sku: '513' }, { name: FILLET, qty: 1, unitPrice: 665, amount: 665, sku: '1' }], units: 2, total: 1515 }],
    ]);
    // The model "corrected" the shop's typo and claimed success for both.
    const reported = report({
      ops: [
        { name: 'Горіхова паста з фундуком 350 г', targetQty: 1, status: 'ok', actualQty: 1 },
        { name: FILLET, targetQty: 2, status: 'ok', actualQty: 2 },
      ],
    });
    const result = finalizeExecuteResult(req, reported, CART_URL, page);
    expect(result.ops).toEqual([
      { name: PASTE, targetQty: 1, status: 'ok', actualQty: 1 },
      { name: FILLET, targetQty: 2, status: 'failed', actualQty: 1, detail: 'Tilda did not add the product' },
    ]);
    expect(result.cart).toEqual([
      { name: PASTE, qty: 1, unitPrice: 850, amount: 850, sku: '513' },
      { name: FILLET, qty: 1, unitPrice: 665, amount: 665, sku: '1' },
    ]);
  });

  it('ignores a basket read made before the last change, and a setQty with another target', () => {
    const req = request([{ name: FILLET, targetQty: 2 }]);
    const page = pageOf([
      ['window.__poo.readCart()', { lines: [{ name: FILLET, qty: 5 }], units: 5, total: 0 }],
      [`window.__poo.setQty(${JSON.stringify(FILLET)}, 3)`, { status: 'ok', name: FILLET, before: 5, after: 3 }],
    ]);
    const reported = report({ ops: [{ name: FILLET, targetQty: 2, status: 'ok', actualQty: 2 }], cart: [{ name: FILLET, qty: 2 }] });
    const result = finalizeExecuteResult(req, reported, CART_URL, page);
    expect(result.ops).toEqual([{ name: FILLET, targetQty: 2, status: 'ok', actualQty: 2 }]);
    expect(result.cart).toEqual([{ name: FILLET, qty: 2 }]);
  });

  it('reports not_found with the closest names the helper gave', () => {
    const req = request([{ name: 'Масло ГХІ, 330 г', targetQty: 1 }]);
    const page = pageOf([
      ['window.__poo.setQty("Масло ГХІ, 330 г", 1)', { status: 'not_found', name: 'Масло ГХІ, 330 г', before: 0, after: 0, detail: 'no product card with this exact name; closest: Масло ГХІ, 470 мл' }],
    ]);
    expect(finalizeExecuteResult(req, report({ ops: [] }), CART_URL, page).ops).toEqual([
      { name: 'Масло ГХІ, 330 г', targetQty: 1, status: 'not_found', actualQty: 0, detail: 'no product card with this exact name; closest: Масло ГХІ, 470 мл' },
    ]);
  });
});

describe('summarizeExecute', () => {
  it('counts statuses and lists the problems', () => {
    const req = request([
      { name: FILLET, targetQty: 2 },
      { name: LIVER, targetQty: 1 },
      { name: 'Масло ГХІ, 330 г', targetQty: 1 },
      { name: EGGS, targetQty: 3 },
    ]);
    const result = finalizeExecuteResult(
      req,
      report({
        ops: [
          { name: FILLET, targetQty: 2, status: 'ok', actualQty: 2 },
          { name: 'Масло ГХІ, 330 г', targetQty: 1, status: 'not_found', detail: 'candidates: Масло ГХІ, 470 мл' },
          { name: EGGS, targetQty: 3, status: 'failed', actualQty: 1 },
        ],
        cart: [
          { name: FILLET, qty: 2 },
          { name: EGGS, qty: 1 },
        ],
      }),
      CART_URL,
    );
    expect(summarizeExecute('initial', result)).toBe(
      [
        'Basket fill finished: 1 ok, 1 not found, 1 failed, 1 skipped.',
        `- ${LIVER} (target 1): skipped — The agent did not report this operation.`,
        '- Масло ГХІ, 330 г (target 1): not found — candidates: Масло ГХІ, 470 мл',
        `- ${EGGS} (target 3): failed, basket has 1`,
        'Basket now: 2 line(s), 3 unit(s).',
      ].join('\n'),
    );
  });

  it('is short when everything went fine', () => {
    const req = request([{ name: FILLET, targetQty: 0 }], 'fix');
    const result = finalizeExecuteResult(req, report({ ops: [{ name: FILLET, targetQty: 0, status: 'ok', actualQty: 0 }] }), CART_URL);
    expect(summarizeExecute('fix', result)).toBe('Basket fix finished: 1 ok, 0 not found, 0 failed.\nBasket now: 0 line(s), 0 unit(s).');
  });
});
