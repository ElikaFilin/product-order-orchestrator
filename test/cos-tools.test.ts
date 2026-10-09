import { describe, expect, it } from 'vitest';
import type { SubAgentName } from '../src/config/agents.js';
import type { DelegateInput, TaskSnapshot } from '../src/agents/cos/delegation.js';
import { OrderState } from '../src/agents/cos/order-state.js';
import { COS_ALLOWED_TOOLS, CosTools, cosToolServer, type CosToolDeps } from '../src/agents/cos/tools.js';
import type { ExecuteResult, QaResult, Selection } from '../src/shared/contracts.js';

const SHOP = 'karashynyard';
const CART_URL = 'https://karashynyard.com.ua/#opencart';
const FILLET = 'Філе зі стегна індички, 1 кг';
const LIVER = 'Печінка індички, 500 г';

type Reply = Partial<TaskSnapshot> & { state: string };

/** Scripted delegator: records every request and answers with the next scripted snapshot. */
class FakeDelegator {
  readonly sent: Array<{ agent: SubAgentName; input: DelegateInput }> = [];
  readonly answers: Array<{ taskId: string; text: string }> = [];
  private readonly replies: Reply[] = [];
  private lastAgent: SubAgentName = 'explore';

  script(...replies: Reply[]): void {
    this.replies.push(...replies);
  }

  async send(agent: SubAgentName, input: DelegateInput): Promise<TaskSnapshot> {
    this.sent.push({ agent, input });
    this.lastAgent = agent;
    return this.next(input.contextId);
  }

  async answer(taskId: string, text: string): Promise<TaskSnapshot> {
    this.answers.push({ taskId, text });
    return this.next('ctx', taskId);
  }

  async cancel(taskId: string): Promise<TaskSnapshot> {
    return { agent: this.lastAgent, taskId, contextId: 'ctx', state: 'canceled', text: '', updatedAt: new Date() };
  }

  async cancelAll(): Promise<number> {
    return 0;
  }

  activeTasks(): TaskSnapshot[] {
    return [];
  }

  private next(contextId: string, taskId?: string): TaskSnapshot {
    const reply = this.replies.shift();
    if (!reply) throw new Error('no scripted reply');
    return { agent: this.lastAgent, taskId: taskId ?? crypto.randomUUID(), contextId, text: '', updatedAt: new Date(), ...reply };
  }
}

function setup() {
  const state = new OrderState(SHOP);
  const delegator = new FakeDelegator();
  const messages: string[] = [];
  const started: SubAgentName[] = [];
  const deps: CosToolDeps = {
    state,
    delegator,
    supervisor: { ensureRunning: async (name) => void started.push(name) },
    messenger: { send: async (text) => void messages.push(text) },
    cartUrl: CART_URL,
    basketBrowser: 'your default browser',
  };
  return { state, delegator, messages, started, tools: new CosTools(deps) };
}

const parse = (json: string) => JSON.parse(json) as Record<string, unknown> & { next: string };

describe('CosTools', () => {
  it('drives explore -> execute -> qa mismatch -> fix -> qa match with payloads built from the order state', async () => {
    const { state, delegator, messages, started, tools } = setup();
    const question = 'Що замовити?\n1. Філе зі стегна індички, 1 кг\n2. Печінка індички, 500 г';
    const selection: Selection = { type: 'selection', shopId: SHOP, items: [{ name: FILLET, qty: 2 }, { name: LIVER, qty: 1 }] };

    // 1. Explore asks: the question is parked in the order state and relayed verbatim.
    delegator.script({ state: 'input-required', text: question, question, options: ['1 - 2'] });
    const asked = parse(await tools.delegate({ agent: 'explore', instruction: 'The user wants to order' }));
    expect(started).toEqual(['explore']);
    expect(delegator.sent[0]?.input).toMatchObject({ contextId: state.orderId, payloads: [state.exploreSelectRequest()] });
    expect(asked.state).toBe('input-required');
    expect(asked.next).toMatch(/relay_question/);
    const taskId = String(asked.taskId);
    expect(tools.questionsSummary()).toContain(`taskId=${taskId} agent=explore relayed=no`);

    await tools.relayQuestion(taskId, 'Оберіть товари:');
    expect(messages).toEqual([`Оберіть товари:\n\n${question}\n\n• 1 - 2`]);
    expect(state.pendingQuestions.get(taskId)?.relayed).toBe(true);
    expect(tools.questionsSummary()).toMatch(new RegExp(`taskId=${taskId} agent=explore relayed=yes asked=\\S+ relayed_at=\\S+`));

    // 2. The answer completes the selection.
    delegator.script({ state: 'completed', result: selection });
    const selected = parse(await tools.answer(taskId, '1 - 2\n2'));
    expect(delegator.answers).toEqual([{ taskId, text: '1 - 2\n2' }]);
    expect(state.pendingQuestions.size).toBe(0);
    expect(selected.selection).toEqual([{ name: FILLET, qty: 2 }, { name: LIVER, qty: 1 }]);
    expect(selected.next).toMatch(/execute/);

    // 3. Execute initial gets the expected basket; liver is not found.
    const executed: ExecuteResult = {
      type: 'execute-result',
      shopId: SHOP,
      cartUrl: CART_URL,
      ops: [
        { name: FILLET, targetQty: 2, status: 'ok', actualQty: 2 },
        { name: LIVER, targetQty: 1, status: 'not_found' },
      ],
      cart: [],
    };
    delegator.script({ state: 'completed', result: executed });
    const filled = parse(await tools.delegate({ agent: 'execute', instruction: 'Fill the basket' }));
    expect(delegator.sent[1]?.input.payloads).toEqual([
      { type: 'execute-request', shopId: SHOP, mode: 'initial', ops: [{ name: FILLET, targetQty: 2 }, { name: LIVER, targetQty: 1 }] },
    ]);
    expect(filled.next).toMatch(/Not done: .*Печінка.*not_found.*qa/s);
    expect(filled.next).toMatch(/targetQty:0.*chosen name/);

    // 4. QA gets expected + derived focus and reports the missing liver.
    const mismatch: QaResult = {
      type: 'qa-result',
      shopId: SHOP,
      verdict: 'mismatch',
      modalOpened: true,
      cart: [{ name: FILLET, qty: 2 }],
      differences: [{ kind: 'missing', name: LIVER, expectedQty: 1, actualQty: 0 }],
      focus: [],
      cartUrl: CART_URL,
    };
    delegator.script({ state: 'completed', result: mismatch });
    const checked = parse(await tools.delegate({ agent: 'qa', instruction: 'Verify' }));
    expect(delegator.sent[2]?.input.payloads).toEqual([
      {
        type: 'qa-request',
        shopId: SHOP,
        expected: [{ name: FILLET, qty: 2 }, { name: LIVER, qty: 1 }],
        focus: [],
      },
    ]);
    expect(checked.verdict).toBe('mismatch');
    expect(checked.cartUrl).toBeUndefined();
    expect(checked.next).toMatch(/differences/);

    // 5. Fix, then a focused re-check that matches: the report carries the cart link.
    delegator.script({
      state: 'completed',
      result: { ...executed, ops: [{ name: LIVER, targetQty: 1, status: 'ok', actualQty: 1 }] } satisfies ExecuteResult,
    });
    await tools.delegate({ agent: 'execute', action: 'fix', instruction: 'Add the liver', ops: [{ name: LIVER, targetQty: 1 }] });
    expect(delegator.sent[3]?.input.payloads).toEqual([{ type: 'execute-request', shopId: SHOP, mode: 'fix', ops: [{ name: LIVER, targetQty: 1 }] }]);

    delegator.script({
      state: 'completed',
      result: { ...mismatch, verdict: 'match', cart: [{ name: FILLET, qty: 2 }, { name: LIVER, qty: 1 }], differences: [] } satisfies QaResult,
    });
    const matched = parse(await tools.delegate({ agent: 'qa', instruction: 'Re-check' }));
    expect(delegator.sent[4]?.input.payloads).toMatchObject([{ focus: [{ name: LIVER, check: 'present', expectedQty: 1 }] }]);
    expect(matched.cartUrl).toBe(CART_URL);
    expect(matched.next).toContain(CART_URL);
    expect(matched.next).toContain('opens the prepared basket in your default browser');
    expect(state.isVerified()).toBe(true);
  });

  it('never offers the link for a basket QA could only read from the browser storage', async () => {
    const { delegator, state, tools } = setup();
    state.applySelection({ type: 'selection', shopId: SHOP, items: [{ name: FILLET, qty: 2 }] });
    delegator.script({
      state: 'completed',
      result: {
        type: 'qa-result',
        shopId: SHOP,
        verdict: 'match',
        modalOpened: false,
        cart: [{ name: FILLET, qty: 2 }],
        differences: [],
        focus: [],
        cartUrl: CART_URL,
        notes: 'The basket window could not be opened; the lines were read from the browser storage.',
      } satisfies QaResult,
    });
    const checked = parse(await tools.delegate({ agent: 'qa', instruction: 'Verify' }));
    expect(checked).toMatchObject({ verdict: 'match', modalOpened: false, notes: expect.stringContaining('could not be opened') });
    expect(checked.cartUrl).toBeUndefined();
    expect(checked.next).toMatch(/could not open the basket window.*Do not send the cart link/s);
    expect(parse(tools.acceptItems([{ name: FILLET, qty: 2 }])).next).toMatch(/Verify the basket/);
  });

  it('adds a merge selection to the order and fills the whole basket next', async () => {
    const { delegator, state, tools } = setup();
    state.applySelection({ type: 'selection', shopId: SHOP, items: [{ name: FILLET, qty: 2 }] });
    delegator.script({ state: 'completed', result: { type: 'selection', shopId: SHOP, items: [{ name: LIVER, qty: 1 }] } satisfies Selection });
    const added = parse(await tools.delegate({ agent: 'explore', merge: true, instruction: 'The user also wrote: і ще 4' }));
    expect(delegator.sent[0]?.input.payloads).toEqual([{ type: 'explore-request', action: 'select-products', shopId: SHOP, merge: true }]);
    expect(state.expectedItems().map((i) => [i.name, i.qty])).toEqual([
      [FILLET, 2],
      [LIVER, 1],
    ]);
    expect(added.next).toMatch(/added to the order.*action:"initial"/s);
  });

  it('knows when no delegation is in flight any more', async () => {
    const { delegator, tools } = setup();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const send = delegator.send.bind(delegator);
    delegator.send = async (agent, input) => {
      await gate;
      return send(agent, input);
    };
    delegator.script({ state: 'completed', result: { type: 'product-list-update', shopId: SHOP, added: ['x'], removed: [], products: ['x'] } });
    const running = tools.delegate({ agent: 'explore', action: 'update-product-list', add: ['x'], instruction: 'save info' });
    let idle = false;
    const waiting = tools.whenIdle().then(() => (idle = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(idle).toBe(false);
    release();
    await running;
    await waiting;
    expect(idle).toBe(true);
  });

  it('builds update-product-list requests and rejects actions that do not fit the agent', async () => {
    const { delegator, tools } = setup();
    delegator.script({ state: 'completed', result: { type: 'product-list-update', shopId: SHOP, added: ['Нова паста'], removed: [], products: ['a', 'Нова паста'] } });
    const updated = parse(
      await tools.delegate({ agent: 'explore', action: 'update-product-list', add: ['Нова паста'], instruction: 'save info - add "Нова паста"' }),
    );
    expect(delegator.sent[0]?.input.payloads).toEqual([
      { type: 'explore-request', action: 'update-product-list', shopId: SHOP, add: ['Нова паста'], remove: [] },
    ]);
    expect(updated.productList).toEqual({ added: ['Нова паста'], removed: [], size: 2 });

    await expect(tools.delegate({ agent: 'qa', action: 'fix', instruction: 'x' })).rejects.toThrow(/does not fit the qa agent/);
    await expect(tools.delegate({ agent: 'execute', instruction: 'x' })).rejects.toThrow(/expected basket is empty/);
    await expect(tools.relayQuestion('nope')).rejects.toThrow(/No pending question/);
    expect(delegator.sent).toHaveLength(1);
  });

  it('explains a browser failure with the hint and exposes all tools to the model', async () => {
    const { delegator, tools } = setup();
    delegator.script({
      state: 'failed',
      error: { type: 'error', code: 'BROWSER_NOT_CONNECTED', message: 'Cannot reach the browser', hint: 'Install the Playwright MCP Bridge extension.' },
    });
    const failed = parse(await tools.delegate({ agent: 'explore', instruction: 'x' }));
    expect(failed.error).toMatchObject({ code: 'BROWSER_NOT_CONNECTED', hint: 'Install the Playwright MCP Bridge extension.' });
    expect(failed.next).toMatch(/hint verbatim/);

    const server = cosToolServer(tools);
    expect(server).toMatchObject({ type: 'sdk', name: 'cos' });
    expect(COS_ALLOWED_TOOLS).toContain('mcp__cos__delegate_task');
    expect(COS_ALLOWED_TOOLS).toHaveLength(8);
  });
});
