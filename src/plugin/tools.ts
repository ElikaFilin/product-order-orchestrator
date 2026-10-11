/**
 * The plugin's tools. COS's tools build every sub-agent request from the order state and report each task with
 * the `next` step. The children's tools record a question for the user, change the product list, and submit typed
 * results whose final payloads are computed in code (from the page data the plugin captured, not from the model's
 * retelling) and folded into the order at once.
 */
import { Type, type Static, type TSchema } from 'typebox';
import { SUB_AGENTS, type SubAgentName } from '../core/agents.js';
import type { ExecuteResult, ProductListUpdate } from '../core/contracts.js';
import { finalizeExecuteResult, summarizeExecute } from '../core/execute/result.js';
import { resolveStanding, selectionFromRows, withStanding } from '../core/explore/selection.js';
import { describeDifference } from '../core/order-state.js';
import { summarizeQa, toQaResult, QaObservation } from '../core/qa/report.js';
import { getShop } from '../core/shops/index.js';
import { buildRequest, CART_LINK_PLACEHOLDER, cosContext, DELEGATE_ACTIONS, taskReport, type TaskArgs } from './cos.js';
import type { PluginHost, PluginTool, ToolContext, ToolResult } from './host.js';
import type { Runtime } from './runtime.js';
import type { TaskRecord } from './store.js';

export const COS_TOOLS = [
  'poo_task',
  'poo_task_status',
  'poo_answer',
  'poo_order_state',
  'poo_accept_items',
  'poo_new_order',
  'poo_cancel',
] as const;

/** OpenClaw tools for COS's memory: file tools limited to MEMORY.md by the plugin, and memory-core's search and read. */
export const COS_MEMORY_TOOLS = ['read', 'write', 'edit', 'memory_search', 'memory_get'] as const;

/** Child tools and the agent that may call each. */
export const CHILD_TOOLS = {
  poo_ask_user: ['explore', 'execute', 'qa'],
  poo_update_product_list: ['explore'],
  poo_submit_selection: ['explore'],
  poo_submit_execute: ['execute'],
  poo_submit_qa: ['qa'],
} as const satisfies Record<string, readonly SubAgentName[]>;

export const PLUGIN_TOOLS = [...COS_TOOLS, ...Object.keys(CHILD_TOOLS)] as const;

const text = (value: string | Record<string, unknown>, details: unknown = {}): ToolResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 1) }],
  details,
});

const Qty = Type.Integer({ minimum: 0, maximum: 99 });
const Name = Type.String({ minLength: 1 });
const BasketOpSchema = Type.Object({ name: Name, targetQty: Qty, sku: Type.Optional(Type.String()) });
const QaFocusSchema = Type.Object({
  name: Name,
  check: Type.Enum(['quantity', 'present', 'absent']),
  expectedQty: Type.Optional(Qty),
});
const CartLineSchema = Type.Object({
  name: Name,
  qty: Qty,
  unitPrice: Type.Optional(Type.Number({ minimum: 0 })),
  amount: Type.Optional(Type.Number({ minimum: 0 })),
  sku: Type.Optional(Type.String()),
});

interface ToolSpec<S extends TSchema> {
  name: string;
  description: string;
  parameters: S;
  /** Agents the tool is offered to (COS also gets every child tool: its tools are the ceiling of its children's). */
  agents: readonly string[];
  run(params: Static<S>, ctx: ToolContext): Promise<ToolResult> | ToolResult;
}

function register<S extends TSchema>(host: PluginHost, spec: ToolSpec<S>): void {
  host.registerTool(
    (ctx) => {
      if (ctx.agentId && !spec.agents.includes(ctx.agentId) && ctx.agentId !== 'cos') return null;
      const tool: PluginTool = {
        name: spec.name,
        label: spec.name,
        description: spec.description,
        parameters: spec.parameters,
        execute: async (_toolCallId, params) => spec.run(params as Static<S>, ctx),
      };
      return tool;
    },
    { name: spec.name },
  );
}

export function registerTools(host: PluginHost, rt: Runtime): void {
  const { store, settings } = rt;
  const report = (task: TaskRecord) => text(taskReport(store, task, settings), { taskId: task.id, state: task.state });
  const cos = ['cos'];

  // ---------- COS ----------

  register(host, {
    name: 'poo_task',
    agents: cos,
    description:
      'Create a sub-agent task. Its request (selection, expected basket, operations, QA re-checks) is built from the order ' +
      'state automatically. Then start it with sessions_spawn {agentId, task: <taskId>}. explore: select-products (default; ' +
      'merge:true when the user adds products to the current order; standing: the every-order products from your memory, new ' +
      'orders only) | update-product-list (add/remove). execute: initial ' +
      '(default, the whole expected basket) | fix (ops). qa: verify (default; re-checks of the last fix are added automatically).',
    parameters: Type.Object({
      agent: Type.Enum([...SUB_AGENTS]),
      instruction: Type.String({ description: 'Short plain-language instruction with any user wishes or context' }),
      action: Type.Optional(Type.Enum([...DELEGATE_ACTIONS])),
      merge: Type.Optional(Type.Boolean({ description: 'explore select-products: the user adds products to the current order' })),
      standing: Type.Optional(
        Type.Array(Type.Object({ name: Name, qty: Type.Integer({ minimum: 1, maximum: 99 }) }), {
          description: 'explore select-products, new order only: the products your memory says go into every order, with quantities',
        }),
      ),
      ops: Type.Optional(Type.Array(BasketOpSchema, { description: 'execute fix: absolute target quantities; 0 removes the line' })),
      add: Type.Optional(Type.Array(Name, { description: 'explore update-product-list: products to add, as the user wrote them' })),
      remove: Type.Optional(Type.Array(Name, { description: 'explore update-product-list: products to remove' })),
      focus: Type.Optional(Type.Array(QaFocusSchema, { description: 'qa: extra checks the user asked for' })),
    }),
    run: async (params) => {
      const { standing: wanted, ...rest } = params;
      const standing = wanted?.length ? resolveStanding(wanted, await rt.productList.read(store.order.shopId)) : undefined;
      return store.update(() => {
        const args: TaskArgs = { ...(rest as Omit<TaskArgs, 'standing'>), ...(standing ? { standing } : {}) };
        const busy = store.activeTasks().find((t) => t.agent === args.agent || (args.agent !== 'explore' && t.agent !== 'explore'));
        if (busy) {
          throw new Error(
            `Task ${busy.id} (${busy.agent}) is still ${busy.state}. Finish it or cancel it (poo_cancel) first: ` +
              'one task per agent, and Execute and QA never use the browser at the same time.',
          );
        }
        return report(store.createTask(args.agent, buildRequest(store.order, args), args.instruction));
      });
    },
  });

  register(host, {
    name: 'poo_task_status',
    agents: cos,
    description: 'A task with its result and next step, or (without taskId) every task of the current order.',
    parameters: Type.Object({ taskId: Type.Optional(Type.String()) }),
    run: ({ taskId }) => {
      if (!taskId) return text(cosContext(store, settings));
      const task = store.task(taskId);
      if (!task) throw new Error(`Unknown task ${taskId}.`);
      return report(task);
    },
  });

  register(host, {
    name: 'poo_answer',
    agents: cos,
    description: "Store the user's answer to a sub-agent question; then deliver it with sessions_send as the result says.",
    parameters: Type.Object({
      taskId: Type.String({ minLength: 1 }),
      answer: Type.String({ minLength: 1, description: "The user's answer, verbatim unless it needs context to be understood" }),
    }),
    run: ({ taskId, answer }) =>
      store.update(() => {
        const task = store.task(taskId);
        const q = task && store.openQuestion(task);
        if (!task || task.state !== 'input-required' || !q) throw new Error(`Task ${taskId} is not waiting for an answer.`);
        if (!q.relayedAt) throw new Error(`The question of task ${taskId} was not sent to the user yet: relay it first.`);
        q.answer = answer;
        q.answeredAt = store.timestamp();
        return report(store.touch(task, { state: 'answered' }));
      }),
  });

  register(host, {
    name: 'poo_order_state',
    agents: cos,
    description: 'The current order: expected basket, last execute and QA results, tasks and pending questions.',
    parameters: Type.Object({}),
    run: () => text(cosContext(store, settings)),
  });

  register(host, {
    name: 'poo_accept_items',
    agents: cos,
    description: 'The user keeps these basket lines as they are now (qty 0 = not wanted). Updates the expected basket and returns what still differs.',
    parameters: Type.Object({ items: Type.Array(Type.Object({ name: Name, qty: Qty }), { minItems: 1 }) }),
    run: ({ items }) =>
      store.update(() => {
        const state = store.order;
        const open = state.acceptItems(items);
        const formWrong = !state.needsCheck && state.lastQa?.orderForm !== undefined && state.lastQa.orderForm.status !== 'ok';
        const next = open.length
          ? `Still different from what the user wants: ${open.map(describeDifference).join('; ')}. Ask the user or fix with execute.`
          : state.isVerified()
            ? `Nothing differs any more. Send the final message with the basket link (${CART_LINK_PLACEHOLDER}).`
            : formWrong
              ? 'The basket is as the user wants, but the order form is not right: offer to fill it again with poo_task {"agent":"execute"}, then qa.'
              : `Verify the basket with poo_task {"agent":"qa"} before sending the link.`;
        return text({ expected: state.expectedItems(), openDifferences: open, next });
      }),
  });

  register(host, {
    name: 'poo_new_order',
    agents: cos,
    description: 'Start a new order: cancels the tasks of the current one and clears the order state.',
    parameters: Type.Object({}),
    run: () =>
      store.update(() => {
        const running = cancelActive(rt);
        store.order.reset();
        const stop = running.length
          ? ` Stop their runs: ${running.map((runId) => `subagents {"action":"cancel","runId":"${runId}"}`).join(', ')}.`
          : '';
        return text(`New order ${store.order.orderId} started.${stop} Next: poo_task {"agent":"explore"}.`);
      }),
  });

  register(host, {
    name: 'poo_cancel',
    agents: cos,
    description: 'Cancel a sub-agent task (also stop its run with subagents cancel when the result says so).',
    parameters: Type.Object({ taskId: Type.String({ minLength: 1 }) }),
    run: ({ taskId }) =>
      store.update(() => {
        const task = store.task(taskId);
        if (!task) throw new Error(`Unknown task ${taskId}.`);
        const wasRunning = task.state === 'running';
        if (store.isActive(task)) store.touch(task, { state: 'canceled' });
        const stop = wasRunning && task.runId ? ` Stop its run: subagents {"action":"cancel","runId":"${task.runId}"}.` : '';
        return text(`Task ${task.id} is ${task.state}.${stop}`);
      }),
  });

  // ---------- children ----------

  /** The task the calling child session works on; only while it runs. */
  const ownTask = (ctx: ToolContext): TaskRecord => {
    const task = store.taskBySession(ctx.sessionKey);
    if (!task || task.agent !== ctx.agentId) throw new Error('This session has no task: only a task started by the Chief of Staff can use this tool.');
    if (task.state !== 'running') throw new Error(`Task ${task.id} is ${task.state}: end your run now.`);
    return task;
  };
  const done = (summary: string) =>
    `Submitted. End your run now; your last message should be this summary, word for word:\n${summary}`;

  register(host, {
    name: 'poo_ask_user',
    agents: CHILD_TOOLS.poo_ask_user,
    description:
      'Ask the user one question through the Chief of Staff, then end your run. The answer arrives in this session as a new message.',
    parameters: Type.Object({ question: Type.String({ minLength: 1, maxLength: 4000 }) }),
    run: ({ question }, ctx) =>
      store.update(() => {
        const task = ownTask(ctx);
        task.questions.push({ question, askedAt: store.timestamp() });
        store.touch(task, { state: 'input-required' });
        return text('The question was recorded for the user. End your run now with one line saying that you wait for the answer.');
      }),
  });

  register(host, {
    name: 'poo_update_product_list',
    agents: CHILD_TOOLS.poo_update_product_list,
    description:
      'Add products to and/or remove products from the shop product list in the ask-what-to-buy skill. Names to add are saved ' +
      'exactly as given; duplicates and removals are matched ignoring case and extra spaces. Returns what changed.',
    parameters: Type.Object({ add: Type.Optional(Type.Array(Name)), remove: Type.Optional(Type.Array(Name)) }),
    run: async ({ add = [], remove = [] }, ctx) => {
      const task = ownTask(ctx);
      if (task.request.type !== 'explore-request' || task.request.action !== 'update-product-list') {
        throw new Error('This task does not change the product list.');
      }
      const change = await rt.productList.update(task.request.shopId, { add, remove });
      store.update(() => {
        task.listChanges.push(change);
        completeListUpdate(rt, task, change.products.map((p) => p.name));
      });
      const { added, removed, alreadyListed, notFound } = change;
      return text({ added, removed, alreadyListed, notFound, productCount: change.products.length });
    },
  });

  register(host, {
    name: 'poo_submit_selection',
    agents: CHILD_TOOLS.poo_submit_selection,
    description:
      'Submit the products the user chose, by table row, as the result of a select-products task. When the task has ' +
      'every-order products, code adds them; submit no items if the user wants nothing else.',
    parameters: Type.Object({
      outcome: Type.Enum(['selected', 'canceled'], { description: '"canceled" only when the user confirmed they want nothing' }),
      items: Type.Array(
        Type.Object({
          row: Type.Integer({ minimum: 1, description: 'The table # (the number in the question) the user chose' }),
          name: Type.String({ minLength: 1, description: 'That product name, copied from the table (a cross-check of row)' }),
          qty: Type.Integer({ minimum: 1, maximum: 99 }),
        }),
      ),
      notes: Type.Optional(Type.String({ description: 'Anything COS should know, e.g. answer lines that were dropped and why' })),
    }),
    run: async ({ outcome, items, notes }, ctx) => {
      const task = ownTask(ctx);
      const request = task.request;
      if (request.type !== 'explore-request' || request.action !== 'select-products') throw new Error('This task does not select products.');
      if (outcome === 'canceled') {
        const message = `The user chose not to buy anything.${notes ? ` ${notes}` : ''}`;
        store.update(() => store.touch(task, { state: 'failed', error: { code: 'CANCELED', message }, summary: message }));
        return text(done(message));
      }
      const standing = request.standing ?? [];
      if (items.length === 0 && standing.length === 0) throw new Error('Select at least one product, or submit outcome "canceled".');
      const products = await rt.productList.read(request.shopId);
      const selection = withStanding(selectionFromRows(request.shopId, items, products, notes), standing, products);
      const lines = selection.items.map((i) => `${i.name} × ${i.qty}`).join('; ');
      const summary = `Selected ${selection.items.length} product(s): ${lines}.${selection.notes ? ` Notes: ${selection.notes}` : ''}`;
      store.update(() => {
        store.order.applySelection(selection, request.merge === true);
        store.touch(task, { state: 'completed', result: selection, summary });
      });
      return text(done(summary));
    },
  });

  register(host, {
    name: 'poo_submit_execute',
    agents: CHILD_TOOLS.poo_submit_execute,
    description: 'Submit the result of every requested basket operation and the basket lines from your last readCart().',
    parameters: Type.Object({
      ops: Type.Array(
        Type.Object({
          name: Name,
          targetQty: Qty,
          status: Type.Enum(['ok', 'not_found', 'failed', 'skipped']),
          actualQty: Type.Optional(Qty),
          detail: Type.Optional(Type.String()),
        }),
      ),
      cart: Type.Optional(Type.Array(CartLineSchema)),
      notes: Type.Optional(Type.String()),
    }),
    run: ({ ops, cart, notes }, ctx) =>
      store.update(() => {
        const task = ownTask(ctx);
        const request = task.request;
        if (request.type !== 'execute-request') throw new Error('This task does not change the basket.');
        const shop = getShop(request.shopId);
        const reported: ExecuteResult = {
          type: 'execute-result',
          shopId: request.shopId,
          cartUrl: shop.cartUrl,
          ops,
          cart: cart ?? [],
          ...(notes ? { notes } : {}),
        };
        const result = finalizeExecuteResult(request, reported, shop.cartUrl, rt.pageOps.get(task.id), rt.config.checkout);
        const summary = summarizeExecute(request.mode, result, request.clearBasket === true);
        store.order.applyExecuteResult(result, request.mode);
        store.touch(task, { state: 'completed', result, summary });
        return text(done(summary));
      }),
  });

  register(host, {
    name: 'poo_submit_qa',
    agents: CHILD_TOOLS.poo_submit_qa,
    description: 'Submit what you saw in the basket. Report facts only: the verdict is computed in code.',
    parameters: Type.Object({
      modalOpened: Type.Boolean({ description: 'True if the basket window was opened and read' }),
      readVia: Type.Enum(['modal', 'storage', 'both'], { description: 'Where the lines come from' }),
      lines: Type.Array(CartLineSchema, { description: 'Every line in the basket, name exactly as shown' }),
      total: Type.Union([Type.Number({ minimum: 0 }), Type.Null()], { description: 'Basket total as shown, null if not visible' }),
      notes: Type.Optional(Type.String()),
    }),
    run: (params, ctx) =>
      store.update(() => {
        const task = ownTask(ctx);
        const request = task.request;
        if (request.type !== 'qa-request') throw new Error('This task does not check the basket.');
        const observation = QaObservation.parse(params);
        const result = toQaResult(request, observation, getShop(request.shopId).cartUrl, rt.pageReads.get(task.id));
        const summary = summarizeQa(result);
        store.order.applyQaResult(result);
        store.touch(task, { state: 'completed', result, summary });
        return text(done(summary));
      }),
  });
}

/** The result of an update-product-list task so far (it completes when the run ends). */
function completeListUpdate(rt: Runtime, task: TaskRecord, products: string[]): void {
  if (task.request.type !== 'explore-request') return;
  const collect = (pick: (c: TaskRecord['listChanges'][number]) => string[]) => [...new Set(task.listChanges.flatMap(pick))];
  const result: ProductListUpdate = {
    type: 'product-list-update',
    shopId: task.request.shopId,
    added: collect((c) => c.added),
    removed: collect((c) => c.removed),
    products,
  };
  const skipped = [
    ...collect((c) => c.alreadyListed).map((n) => `already listed: ${n}`),
    ...collect((c) => c.notFound).map((n) => `not in the list: ${n}`),
  ];
  const summary = [
    `Product list "${result.shopId}": ${products.length} products.`,
    result.added.length ? `Added: ${result.added.join('; ')}.` : '',
    result.removed.length ? `Removed: ${result.removed.join('; ')}.` : '',
    result.added.length + result.removed.length === 0 ? 'Nothing changed.' : '',
    skipped.length ? `Skipped (${skipped.join('; ')}).` : '',
  ]
    .filter(Boolean)
    .join(' ');
  rt.store.touch(task, { result, summary });
}

/** Cancel every active task; returns the run ids that may still be running. */
export function cancelActive(rt: Runtime): string[] {
  const running: string[] = [];
  for (const task of rt.store.activeTasks()) {
    if (task.state === 'running' && task.runId) running.push(task.runId);
    rt.store.touch(task, { state: 'canceled' });
  }
  return running;
}

/**
 * A child run ended. A task still `running` either finished an update-product-list (its changes are the result)
 * or ended without a result.
 */
export function settleEndedRun(rt: Runtime, task: TaskRecord, outcome: { ok: boolean; error?: string }): void {
  if (task.state !== 'running') return;
  if (outcome.ok && task.result?.type === 'product-list-update') {
    rt.store.touch(task, { state: 'completed' });
    return;
  }
  const message = outcome.ok ? 'The agent ended its run without submitting a result.' : `The agent run failed: ${outcome.error ?? 'unknown error'}.`;
  rt.store.touch(task, { state: 'failed', error: { code: outcome.ok ? 'LLM_ERROR' : 'INTERNAL', message }, summary: message });
}
