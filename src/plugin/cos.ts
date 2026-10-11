/**
 * What COS knows and is told: sub-agent requests built from the order state (the model never retypes JSON or
 * product lists), task reports with the `next` step, and the context injected into every COS turn.
 */
import type { SubAgentName } from '../core/agents.js';
import {
  ExecuteResult,
  pickPayload,
  ProductListUpdate,
  QaResult,
  Selection,
  type BasketItem,
  type BasketOp,
  type QaFocus,
} from '../core/contracts.js';
import { describeOrderForm } from '../core/order-form.js';
import { describeDifference, type OrderState } from '../core/order-state.js';
import type { Store, SubAgentRequest, TaskRecord } from './store.js';

export const DELEGATE_ACTIONS = ['select-products', 'update-product-list', 'initial', 'fix', 'verify'] as const;
export type DelegateAction = (typeof DELEGATE_ACTIONS)[number];

export interface TaskArgs {
  agent: SubAgentName;
  instruction: string;
  action?: DelegateAction;
  merge?: boolean;
  /** explore select-products, new order: products for every order, already resolved to product-list names. */
  standing?: BasketItem[];
  ops?: BasketOp[];
  add?: string[];
  remove?: string[];
  focus?: QaFocus[];
}

/** Where the basket link must be opened and how long a task's run may take, as COS has to say and use them. */
export interface CosSettings {
  cartUrl: string;
  basketBrowser: string;
  runTimeoutSeconds: Record<SubAgentName, number>;
}

export const CART_LINK_PLACEHOLDER = '{{cart_link}}';
export const RELAY_PREFIX = '@relay:';

export function buildRequest(state: OrderState, args: TaskArgs): SubAgentRequest {
  const action = args.action;
  switch (args.agent) {
    case 'explore':
      if (action === 'update-product-list') return state.exploreUpdateRequest(args.add ?? [], args.remove ?? []);
      if (action === undefined || action === 'select-products') return state.exploreSelectRequest(args.merge === true, args.standing);
      break;
    case 'execute':
      if (action === 'fix') return state.executeFixRequest(args.ops ?? []);
      if (action === undefined || action === 'initial') return state.executeInitialRequest();
      break;
    case 'qa':
      if (action === undefined || action === 'verify') return state.qaRequest(args.focus);
      break;
  }
  throw new Error(
    `Action "${action}" does not fit the ${args.agent} agent. Use explore: select-products | update-product-list; execute: initial | fix; qa: verify.`,
  );
}

const json = (value: unknown) => JSON.stringify(value);

function finalMessageStep(s: CosSettings, state: OrderState): string {
  const form =
    state.lastQa?.orderForm?.status === 'ok'
      ? ' Also say that the order form (name, phone, delivery, address) is already filled in the shop tab the agents left open ' +
        'there: the user checks it and presses "Відправити замовлення" in that tab; the link opens the basket in a new tab, where the form is empty.'
      : '';
  return (
    `Send the final message with message ${json({ action: 'send', message: `… ${CART_LINK_PLACEHOLDER} …` })}: the plugin puts the ` +
    `basket link (${s.cartUrl}) where ${CART_LINK_PLACEHOLDER} is. Say that it opens the prepared basket in ${s.basketBrowser}, where the basket lives.${form}`
  );
}

/** The step COS takes next for a task, in the task's current state. */
export function nextStep(store: Store, task: TaskRecord, s: CosSettings): string {
  const spawn = `sessions_spawn ${json({ agentId: task.agent, task: task.id })}`;
  switch (task.state) {
    case 'created':
      return `Start it: ${spawn} (the plugin writes the full task text), then sessions_yield. The result arrives as a completion event.`;
    case 'running':
      return 'It is working; its result arrives as a completion event. Call sessions_yield if you have nothing else to do.';
    case 'input-required': {
      const q = store.openQuestion(task);
      if (q?.relayedAt) return `The question was sent to the user at ${q.relayedAt}. When they answer, call poo_answer ${json({ taskId: task.id, answer: '<the answer>' })}.`;
      return (
        `Send the question verbatim: message ${json({ action: 'send', message: `${RELAY_PREFIX}${task.id}` })} (the plugin writes the question), ` +
        `then end your turn. When the user answers, call poo_answer ${json({ taskId: task.id, answer: '<the answer>' })}.`
      );
    }
    case 'answered':
      return (
        `Give the answer to the same agent session: sessions_send ${json({ sessionKey: task.childSessionKey, message: `answer:${task.id}`, timeoutSeconds: s.runTimeoutSeconds[task.agent] })} ` +
        `(the plugin writes the message). If that session is gone, ${spawn} continues the task in a new session.`
      );
    case 'canceled':
      return 'The task was canceled. If the user canceled it, confirm briefly.';
    case 'failed':
      if (task.error?.code === 'BROWSER_NOT_CONNECTED') return 'Send the user error.hint verbatim, then offer to retry the same step once they have done it.';
      if (task.error?.code === 'CANCELED') return 'The user chose not to buy anything: confirm briefly.';
      return 'Tell the user in one sentence what failed and offer to retry the step (a new poo_task).';
    case 'completed':
      return completedStep(store.order, task, s);
  }
}

function completedStep(state: OrderState, task: TaskRecord, s: CosSettings): string {
  const data = task.result ? [task.result] : [];
  const selection = pickPayload(data, Selection);
  const listUpdate = pickPayload(data, ProductListUpdate);
  const executed = pickPayload(data, ExecuteResult);
  const qa = pickPayload(data, QaResult);
  const merged = task.request.type === 'explore-request' && task.request.action === 'select-products' && task.request.merge === true;
  if (selection && merged) {
    return (
      'These products were added to the order (quantities of a product already in it add up). Confirm the whole order ' +
      `(see <order_state>) in one short message, then poo_task ${json({ agent: 'execute' })}: it sets the whole expected basket, ` +
      'and lines that are already right do not change.'
    );
  }
  if (selection) return `Confirm the selection to the user in one short message, then poo_task ${json({ agent: 'execute' })}.`;
  if (listUpdate) return 'Confirm to the user what was added/removed; the next product question will include the change.';
  if (executed) {
    const notDone = executed.ops.filter((o) => o.status !== 'ok');
    const note = notDone.length ? `Not done: ${notDone.map((o) => `${o.name} (${o.status})`).join(', ')}. ` : '';
    const replace = notDone.some((o) => o.status === 'not_found')
      ? ' If the user later picks one of the closest names from detail instead, fix with both ops: ' +
        '[{name:<not found name>, targetQty:0}, {name:<chosen name copied from detail>, targetQty:N}].'
      : '';
    return `${note}Next: poo_task ${json({ agent: 'qa' })}; the re-check focus is derived automatically.${replace}`;
  }
  if (qa) {
    if (state.isVerified()) return `Basket verified. ${finalMessageStep(s, state)}`;
    if (!qa.modalOpened && state.openDifferences().length === 0) {
      return (
        'The basket matches, but QA could not open the basket window, so it was not checked the way the user sees it. ' +
        `Tell the user in one sentence and offer to check again (poo_task ${json({ agent: 'qa' })}). Do not send the cart link yet.`
      );
    }
    if (state.openDifferences().length === 0 && qa.orderForm && qa.orderForm.status !== 'ok') {
      return (
        `The basket matches, but the order form in Execute's tab is not right. ${describeOrderForm(qa.orderForm)} Tell the user in one ` +
        `short message and offer to fill it again: poo_task ${json({ agent: 'execute' })} (the same basket, so its lines do not change, ` +
        'and the form is filled in a new tab), then qa. Do not send the cart link yet.'
      );
    }
    return (
      `Tell the user the differences and ask what to do: fix them (poo_task ${json({ agent: 'execute', action: 'fix', ops: [{ name: '<name>', targetQty: 0 }] })}, ` +
      'targetQty is the absolute quantity, 0 removes) or keep the basket as it is (poo_accept_items).'
    );
  }
  return 'The task completed without a recognised result; tell the user and offer to retry.';
}

/** A task as COS sees it in tool results. */
export function taskReport(store: Store, task: TaskRecord, s: CosSettings): Record<string, unknown> {
  const data = task.result ? [task.result] : [];
  const selection = pickPayload(data, Selection);
  const listUpdate = pickPayload(data, ProductListUpdate);
  const executed = pickPayload(data, ExecuteResult);
  const qa = pickPayload(data, QaResult);
  const question = store.openQuestion(task);
  return {
    taskId: task.id,
    agent: task.agent,
    state: task.state,
    ...(task.childSessionKey ? { sessionKey: task.childSessionKey } : {}),
    ...(question ? { question: question.question, asked_at: question.askedAt, ...(question.relayedAt ? { relayed_at: question.relayedAt } : {}) } : {}),
    ...(task.summary ? { summary: task.summary } : {}),
    ...(selection ? { selection: selection.items.map((i) => ({ name: i.name, qty: i.qty })), ...(selection.notes ? { notes: selection.notes } : {}) } : {}),
    ...(listUpdate ? { productList: { added: listUpdate.added, removed: listUpdate.removed, size: listUpdate.products.length } } : {}),
    ...(executed
      ? {
          operations: executed.ops.map((o) => ({ name: o.name, targetQty: o.targetQty, status: o.status, actualQty: o.actualQty, detail: o.detail })),
          ...(executed.orderForm ? { orderForm: executed.orderForm } : {}),
        }
      : {}),
    ...(qa
      ? {
          verdict: qa.verdict,
          modalOpened: qa.modalOpened,
          differences: qa.differences,
          failedChecks: qa.focus.filter((f) => !f.passed),
          ...(qa.orderForm ? { orderForm: qa.orderForm } : {}),
          ...(qa.total === undefined ? {} : { total: qa.total }),
          ...(qa.notes ? { notes: qa.notes } : {}),
        }
      : {}),
    ...(task.error ? { error: task.error } : {}),
    next: nextStep(store, task, s),
  };
}

/** The order and its tasks, injected into every COS turn (the model never has to remember them). */
export function cosContext(store: Store, s: CosSettings): string {
  const tasks = store.orderTasks().filter((t) => store.isActive(t) || t === store.orderTasks().at(-1) || recent(store, t));
  const others = store.activeTasks().filter((t) => t.orderId !== store.order.orderId);
  const lines = [...tasks, ...others].map((t) => {
    const r = taskReport(store, t, s);
    const what = t.summary ?? (t.error ? t.error.message : '');
    return `- ${t.id} (${t.agent}) ${t.state}${what ? `: ${what.replace(/\s+/g, ' ').slice(0, 300)}` : ''}\n  next: ${String(r.next)}`;
  });
  const questions = [...tasks, ...others].flatMap((t) => {
    const q = store.openQuestion(t);
    if (!q || t.state !== 'input-required') return [];
    return [
      `- taskId=${t.id} agent=${t.agent} received_at=${q.askedAt}${q.relayedAt ? ` relayed_at=${q.relayedAt}` : ' (not sent to the user yet)'}\n` +
        `  question: ${q.question.replace(/\s+/g, ' ').slice(0, 400)}`,
    ];
  });
  return [
    '<order_state>',
    store.order.summary(),
    '</order_state>',
    '<subagent_tasks>',
    ...(lines.length ? lines : ['none']),
    '</subagent_tasks>',
    '<pending_subagent_questions>',
    ...(questions.length ? questions : ['none: a user message is not an answer to any sub-agent question']),
    '</pending_subagent_questions>',
  ].join('\n');
}

/** Finished tasks stay in the context until a newer task of the same agent exists. */
function recent(store: Store, task: TaskRecord): boolean {
  const newer = store.orderTasks().filter((t) => t.agent === task.agent && t.createdAt > task.createdAt);
  return newer.length === 0;
}

export function describeOpenDifferences(state: OrderState): string {
  return state.openDifferences().map(describeDifference).join('; ');
}
