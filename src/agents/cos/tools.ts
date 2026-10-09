/**
 * The COS model's only tools (in-process MCP server "cos"): Telegram out, delegation to the
 * sub-agents over A2A, and the order state. Sub-agent payloads are built from OrderState in code
 * and results are folded back into it, so the model never retypes JSON or product lists.
 */
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { SUB_AGENTS, type SubAgentName } from '../../config/agents.js';
import { env } from '../../config/env.js';
import {
  BasketOp,
  ExecuteResult,
  pickPayload,
  ProductListUpdate,
  QaFocus,
  QaResult,
  Selection,
  type ExecuteRequest,
  type ExploreRequest,
  type QaRequest,
} from '../../shared/contracts.js';
import { errorMessage } from '../../shared/logger.js';
import { preview } from '../../observability/telemetry.js';
import type { Delegator, TaskSnapshot } from './delegation.js';
import { describeDifference, type ItemQty, type OrderState } from './order-state.js';
import type { SubagentSupervisor } from './supervisor.js';

export const COS_SERVER = 'cos';
const TOOL_NAMES = [
  'send_telegram',
  'relay_question',
  'delegate_task',
  'answer_subagent',
  'cancel_subagent',
  'get_order_state',
  'accept_basket_items',
  'new_order',
] as const;
export const COS_ALLOWED_TOOLS = TOOL_NAMES.map((name) => `mcp__${COS_SERVER}__${name}`);
/** Tools that put a message in front of the user. */
export const USER_FACING_TOOLS: ReadonlySet<string> = new Set([`mcp__${COS_SERVER}__send_telegram`, `mcp__${COS_SERVER}__relay_question`]);

export interface Messenger {
  send(text: string): Promise<void>;
}

const DELEGATE_ACTIONS = ['select-products', 'update-product-list', 'initial', 'fix', 'verify'] as const;

export interface DelegateArgs {
  agent: SubAgentName;
  instruction: string;
  action?: (typeof DELEGATE_ACTIONS)[number];
  merge?: boolean;
  ops?: BasketOp[];
  add?: string[];
  remove?: string[];
  focus?: QaFocus[];
}

type SubAgentRequest = ExploreRequest | ExecuteRequest | QaRequest;

export interface CosToolDeps {
  state: OrderState;
  delegator: Pick<Delegator, 'send' | 'answer' | 'cancel' | 'cancelAll' | 'activeTasks'>;
  supervisor: Pick<SubagentSupervisor, 'ensureRunning'>;
  messenger: Messenger;
  /** Link that opens the prepared basket in the user's browser. */
  cartUrl: string;
  /** Where that link must be opened, as the final message should say it ("your default browser", ...). */
  basketBrowser: string;
}

/** Tool behaviour, independent of MCP so it can be driven from code (/stop, /new) and tests. */
export class CosTools {
  /** The request each task was started with (an execute result is applied by its mode). */
  private readonly requests = new Map<string, SubAgentRequest>();
  /** Delegations still waiting for a sub-agent; one can outlive the model session that started it. */
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(private readonly deps: CosToolDeps) {}

  /** Resolves once no delegation, answer or cancel is in flight (their results are in the order state). */
  async whenIdle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  async sendTelegram(text: string): Promise<string> {
    await this.deps.messenger.send(text);
    return 'Sent.';
  }

  async relayQuestion(taskId: string, preface?: string): Promise<string> {
    const { state } = this.deps;
    const q = state.pendingQuestions.get(taskId);
    if (!q) throw new Error(`No pending question for task ${taskId}. Pending: ${[...state.pendingQuestions.keys()].join(', ') || 'none'}.`);
    const options = q.options?.length ? `\n\n${q.options.map((o) => `• ${o}`).join('\n')}` : '';
    await this.deps.messenger.send([preface?.trim(), `${q.question}${options}`].filter(Boolean).join('\n\n'));
    state.markRelayed(taskId);
    return 'The question was sent to the user. End your turn and wait for their reply.';
  }

  delegate(args: DelegateArgs): Promise<string> {
    return this.track(async () => {
      const { state, supervisor, delegator } = this.deps;
      const request = this.buildRequest(args);
      await supervisor.ensureRunning(args.agent);
      const snapshot = await delegator.send(args.agent, { instruction: args.instruction, payloads: [request], contextId: state.orderId });
      if (snapshot.taskId) this.requests.set(snapshot.taskId, request);
      return this.record(snapshot);
    });
  }

  answer(taskId: string, answer: string): Promise<string> {
    return this.track(async () => {
      this.deps.state.removeQuestion(taskId);
      return this.record(await this.deps.delegator.answer(taskId, answer));
    });
  }

  cancel(taskId: string): Promise<string> {
    return this.track(async () => this.record(await this.deps.delegator.cancel(taskId)));
  }

  orderState(): string {
    const active = this.deps.delegator.activeTasks();
    const tasks = active.length
      ? active.map((t) => `- ${t.agent} task ${t.taskId}: ${t.state}${t.text ? ` — ${preview(t.text, 200)}` : ''}`).join('\n')
      : 'none';
    return `${this.deps.state.summary()}\n${this.questionsSummary()}\nActive sub-agent tasks:\n${tasks}`;
  }

  /** Pending questions as the COS model sees them in every incoming message. */
  questionsSummary(): string {
    const pending = [...this.deps.state.pendingQuestions.values()];
    if (pending.length === 0) return 'No sub-agent question is waiting for the user.';
    return pending
      .map(
        (q) =>
          `- taskId=${q.taskId} agent=${q.agent} relayed=${q.relayed ? 'yes' : 'no'} asked=${q.askedAt.toISOString()}` +
          `${q.relayedAt ? ` relayed_at=${q.relayedAt.toISOString()}` : ''}\n` +
          `  question: ${preview(q.question, 400)}`,
      )
      .join('\n');
  }

  acceptItems(items: ItemQty[]): string {
    const { state } = this.deps;
    const open = state.acceptItems(items);
    const next = open.length
      ? `Still different from what the user wants: ${open.map(describeDifference).join('; ')}. Ask the user or fix with execute.`
      : state.isVerified()
        ? `Nothing differs any more. ${this.finalMessageStep()}`
        : 'Verify the basket with delegate_task {agent:"qa"} before sending the link.';
    return JSON.stringify({ expected: state.expectedItems(), openDifferences: open, next }, null, 1);
  }

  /** Cancel every running/pending sub-agent task (used by /stop and new_order). */
  async cancelAll(): Promise<number> {
    const canceled = await this.deps.delegator.cancelAll();
    this.deps.state.pendingQuestions.clear();
    return canceled;
  }

  async newOrder(): Promise<string> {
    const canceled = await this.cancelAll();
    this.deps.state.reset();
    return `New order ${this.deps.state.orderId} started (${canceled} running task(s) canceled). Next: delegate_task {agent:"explore", action:"select-products"}.`;
  }

  // ---------- internals ----------

  private track(work: () => Promise<string>): Promise<string> {
    const running = work();
    this.inFlight.add(running);
    void running.then(
      () => this.inFlight.delete(running),
      () => this.inFlight.delete(running),
    );
    return running;
  }

  private finalMessageStep(): string {
    return (
      `Send the final message with the cart link ${this.deps.cartUrl}; say that it opens the prepared basket in ` +
      `${this.deps.basketBrowser}, where the basket lives.`
    );
  }

  private buildRequest(args: DelegateArgs): SubAgentRequest {
    const { state } = this.deps;
    const action = args.action;
    switch (args.agent) {
      case 'explore':
        if (action === 'update-product-list') return state.exploreUpdateRequest(args.add ?? [], args.remove ?? []);
        if (action === undefined || action === 'select-products') return state.exploreSelectRequest(args.merge === true);
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

  /** Fold a snapshot into the order state and describe it for the model. */
  private record(snapshot: TaskSnapshot): string {
    const { state } = this.deps;
    if (snapshot.state === 'input-required') {
      state.addQuestion({
        taskId: snapshot.taskId,
        agent: snapshot.agent,
        question: snapshot.question || snapshot.text,
        ...(snapshot.options?.length ? { options: snapshot.options } : {}),
      });
    } else {
      state.removeQuestion(snapshot.taskId);
    }
    const data = snapshot.state === 'completed' && snapshot.result !== undefined ? [snapshot.result] : [];
    const selection = pickPayload(data, Selection);
    const listUpdate = pickPayload(data, ProductListUpdate);
    const executed = pickPayload(data, ExecuteResult);
    const qa = pickPayload(data, QaResult);
    const request = this.requests.get(snapshot.taskId);
    const merged = request?.type === 'explore-request' && request.action === 'select-products' && request.merge === true;
    if (selection) state.applySelection(selection, merged);
    if (executed) state.applyExecuteResult(executed, request?.type === 'execute-request' ? request.mode : 'fix');
    if (qa) state.applyQaResult(qa);
    if (snapshot.state !== 'input-required') this.requests.delete(snapshot.taskId);

    const asking = snapshot.state === 'input-required';
    const recognised = selection ?? listUpdate ?? executed ?? qa;
    const report = {
      agent: snapshot.agent,
      taskId: snapshot.taskId,
      state: snapshot.state,
      ...(snapshot.text && !asking ? { message: preview(snapshot.text, 600) } : {}),
      ...(asking
        ? { question: preview(snapshot.question || snapshot.text, 800), ...(snapshot.options?.length ? { options: snapshot.options } : {}) }
        : {}),
      ...(selection ? { selection: selection.items.map((i) => ({ name: i.name, qty: i.qty })), notes: selection.notes } : {}),
      ...(listUpdate ? { productList: { added: listUpdate.added, removed: listUpdate.removed, size: listUpdate.products.length } } : {}),
      ...(executed
        ? {
            operations: executed.ops.map((o) => ({ name: o.name, targetQty: o.targetQty, status: o.status, actualQty: o.actualQty, detail: o.detail })),
          }
        : {}),
      ...(qa
        ? {
            verdict: qa.verdict,
            modalOpened: qa.modalOpened,
            differences: qa.differences,
            failedChecks: qa.focus.filter((f) => !f.passed),
            total: qa.total,
            notes: qa.notes,
          }
        : {}),
      ...(qa && state.isVerified() ? { cartUrl: this.deps.cartUrl } : {}),
      ...(snapshot.error ? { error: snapshot.error } : {}),
      ...(snapshot.result !== undefined && !recognised ? { result: preview(snapshot.result, 1_500) } : {}),
      next: this.nextStep(snapshot, { selection, merged, listUpdate, executed, qa }),
    };
    return JSON.stringify(report, null, 1);
  }

  private nextStep(
    snapshot: TaskSnapshot,
    r: { selection?: Selection; merged: boolean; listUpdate?: ProductListUpdate; executed?: ExecuteResult; qa?: QaResult },
  ): string {
    const { taskId, error } = snapshot;
    switch (snapshot.state) {
      case 'input-required':
        return `Call relay_question {taskId:"${taskId}"} (it sends the question verbatim), then end your turn. When the user replies, call answer_subagent.`;
      case 'canceled':
        return 'The task was canceled. If the user canceled it in their answer, confirm briefly (after /stop they were already told).';
      case 'completed':
        break;
      default:
        if (error?.code === 'BROWSER_NOT_CONNECTED') {
          return 'Send the user error.hint verbatim, then offer to retry the same delegate_task once they have done it.';
        }
        if (error?.code === 'SESSION_LOST') return 'The agent lost this task. Start a new delegate_task for the same step.';
        return 'Tell the user in one sentence what failed and offer to retry the step.';
    }
    if (r.selection && r.merged) {
      return (
        'These products were added to the order (quantities of a product already in it add up). Confirm the whole order ' +
        '(get_order_state) in one short message, then delegate_task {agent:"execute", action:"initial"}: it sets the whole ' +
        'expected basket, and lines that are already right do not change.'
      );
    }
    if (r.selection) return 'Confirm the selection to the user in one short message, then delegate_task {agent:"execute", action:"initial"}.';
    if (r.listUpdate) return 'Confirm to the user what was added/removed; the next product question will include the change.';
    if (r.executed) {
      const notDone = r.executed.ops.filter((o) => o.status !== 'ok');
      const note = notDone.length ? `Not done: ${notDone.map((o) => `${o.name} (${o.status})`).join(', ')}. ` : '';
      const replace = notDone.some((o) => o.status === 'not_found')
        ? ' If the user later picks one of the closest names from detail instead, fix with both ops: ' +
          '[{name:<not found name>, targetQty:0}, {name:<chosen name copied from detail>, targetQty:N}].'
        : '';
      return `${note}Next: delegate_task {agent:"qa", action:"verify"}; the re-check focus is derived automatically.${replace}`;
    }
    if (r.qa) {
      const state = this.deps.state;
      if (state.isVerified()) return `Basket verified. ${this.finalMessageStep()}`;
      if (!r.qa.modalOpened && state.openDifferences().length === 0) {
        return (
          'The basket matches, but QA could not open the basket window, so it was not checked the way the user sees it. ' +
          'Tell the user in one sentence and offer to check again with delegate_task {agent:"qa"}. Do not send the cart link yet.'
        );
      }
      return (
        'Tell the user the differences and ask what to do: fix them (delegate_task {agent:"execute", action:"fix", ops:[{name, targetQty}]}, ' +
        'targetQty is the absolute quantity, 0 removes) or keep the basket as it is (accept_basket_items).'
      );
    }
    return 'The task completed without a recognised result; tell the user and offer to retry.';
  }
}

/** Wrap CosTools as the in-process MCP server the COS model calls. A fresh one per session. */
export function cosToolServer(tools: CosTools): McpSdkServerConfigWithInstance {
  const run = async (fn: () => string | Promise<string>): Promise<CallToolResult> => {
    try {
      return { content: [{ type: 'text', text: await fn() }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${errorMessage(err)}` }], isError: true };
    }
  };
  const userFacing = { annotations: { readOnlyHint: false, openWorldHint: true } };

  return createSdkMcpServer({
    name: COS_SERVER,
    version: '0.1.0',
    alwaysLoad: true,
    // A delegation waits for the sub-agent (minutes for Execute); never cut it shorter than A2A does.
    timeout: env().SUBAGENT_TIMEOUT_MS + 60_000,
    tools: [
      tool(
        'send_telegram',
        'Send a message to the user in Telegram (plain text, no Markdown). Your only way to talk to the user.',
        { text: z.string().min(1).describe('Message text in the user language') },
        ({ text }) => run(() => tools.sendTelegram(text)),
        userFacing,
      ),
      tool(
        'relay_question',
        "Send a sub-agent's pending question to the user verbatim (with an optional one-line preface). " +
          'Use it instead of retyping questions, especially product lists.',
        {
          taskId: z.string().min(1).describe('taskId of the sub-agent task that asked'),
          preface: z.string().max(300).optional().describe('Optional short line shown before the question'),
        },
        ({ taskId, preface }) => run(() => tools.relayQuestion(taskId, preface)),
        userFacing,
      ),
      tool(
        'delegate_task',
        'Start a new task on a sub-agent over A2A and wait until it completes, fails or asks the user a question. ' +
          'The structured payload (selection, expected basket, operations, QA focus) is built from the order state automatically. ' +
          'explore: select-products (default; merge:true when the user adds products to the current order) | update-product-list (add/remove). ' +
          'execute: initial (default, the whole expected basket) | fix (ops). qa: verify (default; re-checks of the last fix are added automatically).',
        {
          agent: z.enum(SUB_AGENTS),
          instruction: z.string().min(1).describe('Short plain-language instruction with any user wishes or context'),
          action: z.enum(DELEGATE_ACTIONS).optional(),
          merge: z
            .boolean()
            .optional()
            .describe('explore select-products: the user adds products to the current order; the result is added to it (quantities add up)'),
          ops: z.array(BasketOp).optional().describe('execute fix: absolute target quantities; targetQty 0 removes the line'),
          add: z.array(z.string().min(1)).optional().describe('explore update-product-list: products to add, as the user wrote them'),
          remove: z.array(z.string().min(1)).optional().describe('explore update-product-list: products to remove'),
          focus: z.array(QaFocus).optional().describe('qa: extra checks the user asked for; added to the re-checks derived from the last fix'),
        },
        (args) => run(() => tools.delegate(args)),
        userFacing,
      ),
      tool(
        'answer_subagent',
        "Pass the user's answer to the sub-agent task that asked (same task). Waits for the task's next result or question.",
        {
          taskId: z.string().min(1),
          answer: z.string().min(1).describe("The user's answer, verbatim unless it needs context to be understood"),
        },
        ({ taskId, answer }) => run(() => tools.answer(taskId, answer)),
        userFacing,
      ),
      tool(
        'cancel_subagent',
        'Cancel a running or waiting sub-agent task.',
        { taskId: z.string().min(1) },
        ({ taskId }) => run(() => tools.cancel(taskId)),
        userFacing,
      ),
      tool(
        'get_order_state',
        'The current order: expected basket, last execute and QA results, pending questions and active tasks.',
        {},
        () => run(() => tools.orderState()),
        { annotations: { readOnlyHint: true, openWorldHint: false } },
      ),
      tool(
        'accept_basket_items',
        'The user keeps these basket lines as they are now (qty 0 = not wanted). Updates the expected basket and returns what still differs.',
        { items: z.array(z.object({ name: z.string().min(1), qty: z.number().int().min(0).max(99) })).min(1) },
        ({ items }) => run(() => tools.acceptItems(items)),
        { annotations: { readOnlyHint: false, openWorldHint: false } },
      ),
      tool(
        'new_order',
        'Start a new order: cancels running sub-agent tasks and clears the order state.',
        {},
        () => run(() => tools.newOrder()),
        { annotations: { readOnlyHint: false, openWorldHint: false } },
      ),
    ],
  });
}
