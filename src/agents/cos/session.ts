/**
 * The COS model: ONE long-lived Agent SDK session fed with Telegram messages (streaming input).
 * Order facts live in code and are injected into every message, so a session that crashes or runs
 * out of budget or turns is replaced by a fresh one, which continues the order from those facts.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  query,
  type McpSdkServerConfigWithInstance,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { agentHome } from '../../config/agents.js';
import { env } from '../../config/env.js';
import type { ObsIds } from '../../observability/events.js';
import { preview, type Telemetry } from '../../observability/telemetry.js';
import { buildAgentOptions, requireApiKey, SdkObserver } from '../../shared/claude.js';
import { createLogger, errorMessage } from '../../shared/logger.js';
import { AgentTaskError } from '../../shared/task-executor.js';
import type { OrderState } from './order-state.js';
import { reply, type Lang } from './replies.js';
import { COS_ALLOWED_TOOLS, COS_SERVER, USER_FACING_TOOLS } from './tools.js';

/** Model turns per session before it is replaced (each tool call is a turn). */
const MAX_TURNS_PER_SESSION = 200;
const MAX_RESTART_DELAY_MS = 30_000;
/**
 * COS_MAX_BUDGET_USD counts the spend of one session (all its turns). Past this share of it the session is
 * replaced between turns, so the limit rarely stops the model in the middle of a step.
 */
const ROTATE_AT_BUDGET_SHARE = 0.6;
/** What the model writes to end a turn (agents/cos/AGENTS.md); never shown to the user. */
const END_OF_TURN = 'done';
const RESUME_EVENT =
  'The previous session stopped in the middle of a step (it ran out of budget or turns). Continue the current order ' +
  'from <order_state> and <pending_subagent_questions>; do not ask the user to repeat anything.';

export interface CosSessionDeps {
  state: OrderState;
  telemetry: Telemetry;
  /** A fresh in-process tool server for every session (an MCP server instance serves one session). */
  makeToolServer(): McpSdkServerConfigWithInstance;
  /** Pending sub-agent questions, rendered for the model. */
  describeQuestions(): string;
  /** Resolves once no delegation started by a tool call is still running. */
  whenToolsIdle(): Promise<void>;
  /** The user's language, for the notices code sends. */
  lang(): Lang;
  /** Message the user outside the model (setup errors, lost turns, fallback replies). */
  notify(text: string): Promise<void>;
}

export interface InboxEntry {
  kind: 'telegram' | 'system';
  text: string;
  receivedAt: Date;
  /** Arrived while the model was still working on earlier messages. */
  queued: boolean;
}

export class CosSession {
  private readonly log = createLogger('cos:session');
  private readonly inbox = new Inbox<InboxEntry>();
  private readonly lifetime = new AbortController();
  private readonly systemPrompt: string;
  /** Live correlation ids: /new replaces the order id, and every event must carry the current one. */
  private readonly ids: ObsIds;
  private current: Query | undefined;
  private loop: Promise<void> | undefined;
  private setupError: string | undefined;
  /** Messages were handed to the model and their turn has not finished. */
  private turnOpen = false;
  /** A cut session's step is waiting to be continued by the next one. */
  private resuming = false;
  /** The waiting step should still be continued (a /stop drops it). */
  private resumeWanted = false;
  /** Lets the input generator hand over the next messages (the current turn ended). */
  private releaseTurn: () => void = () => {};
  private turnMessagedUser = false;
  private interrupted = false;

  constructor(private readonly deps: CosSessionDeps) {
    this.systemPrompt = readFileSync(path.join(agentHome('cos'), 'AGENTS.md'), 'utf8');
    const state = deps.state;
    this.ids = {
      get contextId() {
        return state.orderId;
      },
    };
  }

  /** Start the session loop. Without an API key the bot keeps running and answers with a setup error. */
  start(): void {
    try {
      requireApiKey();
    } catch (err) {
      this.setupError = err instanceof AgentTaskError && err.hint ? `${err.message} ${err.hint}` : errorMessage(err);
      this.log.error(this.setupError);
      this.deps.telemetry.status('error', this.setupError);
      return;
    }
    this.loop = this.run();
  }

  /** The model is working on a message (or a cut step is about to be continued). */
  get busy(): boolean {
    return this.turnOpen || this.resuming;
  }

  push(text: string): void {
    if (this.setupError) {
      void this.safeNotify(reply(this.deps.lang(), 'setupError', this.setupError));
      return;
    }
    if (!this.lifetime.signal.aborted) this.inbox.push({ kind: 'telegram', text, receivedAt: new Date(), queued: this.busy });
  }

  /** Stop the current model turn (/stop), or drop a cut step that waits to be continued. The session stays alive. */
  async interrupt(): Promise<void> {
    this.resumeWanted = false;
    if (!this.current || !this.turnOpen) return;
    this.interrupted = true;
    try {
      await this.current.interrupt();
    } catch (err) {
      this.log.warn({ err: errorMessage(err) }, 'interrupt failed');
    }
  }

  async close(): Promise<void> {
    this.lifetime.abort();
    this.current?.close();
    await this.loop;
  }

  // ---------- internals ----------

  private async run(): Promise<void> {
    let failures = 0;
    while (!this.lifetime.signal.aborted) {
      const input = new AbortController();
      const observer = new SdkObserver(this.deps.telemetry, this.ids);
      const q = query({ prompt: this.messages(AbortSignal.any([input.signal, this.lifetime.signal])), options: this.options() });
      this.current = q;
      let endReason = 'session ended';
      let end: 'ended' | 'cut' | 'rotated' = 'ended';
      try {
        for await (const msg of q) {
          const result = this.observe(msg, observer);
          if (!result) continue;
          failures = result.is_error ? failures + 1 : 0;
          if (result.subtype === 'error_max_budget_usd' || result.subtype === 'error_max_turns') {
            [end, endReason] = ['cut', result.subtype];
            input.abort(); // before `break`, which awaits the query's return(): no message may go to this session
            break;
          }
          const budget = env().COS_MAX_BUDGET_USD;
          if (result.subtype === 'success' && result.total_cost_usd >= ROTATE_AT_BUDGET_SHARE * budget) {
            [end, endReason] = ['rotated', `spent $${result.total_cost_usd.toFixed(2)} of the $${budget} session budget`];
            input.abort(); // between turns: the next messages stay in the inbox for the fresh session
            break;
          }
        }
      } catch (err) {
        failures += 1;
        endReason = errorMessage(err);
        if (!this.lifetime.signal.aborted) this.deps.telemetry.error(err, { source: 'cos-session' });
      } finally {
        input.abort();
        this.releaseTurn();
        q.close();
        this.current = undefined;
      }
      if (this.lifetime.signal.aborted) break;

      if (end === 'rotated') {
        this.log.info({ reason: endReason }, 'COS session replaced between turns');
        this.deps.telemetry.emit('log', { level: 'info', text: `COS session replaced: ${endReason}` }, this.ids);
        continue;
      }
      this.log.warn({ reason: endReason }, 'COS session ended; starting a fresh one');
      this.deps.telemetry.status('starting', `restarting the session: ${preview(endReason, 200)}`, this.ids);
      if (end === 'cut') {
        // The cut turn's delegations may still be running: let their results reach the order state, then have
        // the fresh session continue the step (and relay a question that was never sent).
        this.resuming = true;
        this.resumeWanted = true;
        await Promise.race([this.deps.whenToolsIdle(), new Promise((resolve) => this.lifetime.signal.addEventListener('abort', resolve, { once: true }))]);
        this.resuming = false;
        if (this.lifetime.signal.aborted) break;
        if (this.resumeWanted) this.inbox.push({ kind: 'system', text: RESUME_EVENT, receivedAt: new Date(), queued: false });
      } else if (this.turnOpen) {
        this.turnOpen = false;
        await this.safeNotify(reply(this.deps.lang(), 'lostMessage'));
      }
      const backoff = Math.min(MAX_RESTART_DELAY_MS, 1_000 * 2 ** Math.min(failures, 5));
      await delay(backoff, undefined, { signal: this.lifetime.signal }).catch(() => {});
    }
  }

  /**
   * One turn at a time. The SDK asks for the next message right after a yield, but a message handed
   * over while a turn runs is lost if that turn ends the session. So messages that arrive meanwhile
   * wait in the inbox and reach the model together, as the next turn.
   */
  private async *messages(signal: AbortSignal): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const entries = await this.inbox.takeAll(signal);
      if (!entries) return;
      const turnFinished = new Promise<void>((resolve) => (this.releaseTurn = resolve));
      this.turnOpen = true;
      this.deps.telemetry.status('busy', preview(entries.map((e) => e.text).join('\n'), 160), this.ids);
      const content = renderTurn(entries, this.deps.describeQuestions(), this.deps.state.summary());
      yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null };
      await turnFinished;
      if (signal.aborted) return;
    }
  }

  private observe(msg: SDKMessage, observer: SdkObserver): SDKResultMessage | undefined {
    if (msg.type === 'assistant' && msg.message.content.some((b) => b.type === 'tool_use' && USER_FACING_TOOLS.has(b.name))) {
      this.turnMessagedUser = true;
    }
    const result = observer.observe(msg);
    if (!result) return undefined;

    const messaged = this.turnMessagedUser;
    const interrupted = this.interrupted;
    this.turnOpen = false;
    this.turnMessagedUser = false;
    this.interrupted = false;
    this.releaseTurn();
    this.deps.telemetry.status(result.is_error ? 'error' : 'idle', `turn finished: ${result.subtype}`, this.ids);

    if (interrupted) return result;
    // Out of budget or turns: run() lets a fresh session continue the step, so nothing to apologise for yet.
    if (result.subtype === 'error_max_budget_usd' || result.subtype === 'error_max_turns') return result;
    if (result.is_error || result.subtype !== 'success') {
      const why = result.subtype === 'success' ? preview(result.result, 200) : result.subtype;
      void this.safeNotify(reply(this.deps.lang(), 'notFinished', why));
    } else if (!messaged && !isEndOfTurn(result.result)) {
      // The model answered in plain text instead of send_telegram: deliver it rather than drop it.
      void this.safeNotify(result.result.trim());
    }
    return result;
  }

  private options() {
    const e = env();
    return buildAgentOptions({
      agent: 'cos',
      model: e.COS_MODEL,
      cwd: agentHome('cos'),
      systemPrompt: this.systemPrompt,
      builtInTools: [],
      mcpServers: { [COS_SERVER]: this.deps.makeToolServer() },
      allowedTools: COS_ALLOWED_TOOLS,
      maxTurns: MAX_TURNS_PER_SESSION,
      maxBudgetUsd: e.COS_MAX_BUDGET_USD,
      telemetry: this.deps.telemetry,
      ids: this.ids,
    });
  }

  private async safeNotify(text: string): Promise<void> {
    try {
      await this.deps.notify(text);
    } catch (err) {
      this.log.error({ err: errorMessage(err) }, 'could not notify the user');
    }
  }
}

/**
 * One model turn: the user's messages plus the facts the model must not keep in its own memory. Times and the
 * queued mark let the model tell a message written before a question was relayed from an answer to it.
 */
export function renderTurn(entries: readonly InboxEntry[], pendingQuestions: string, orderState: string): string {
  const message = (e: InboxEntry) => {
    const received = `received="${e.receivedAt.toISOString()}"`;
    return e.kind === 'system'
      ? `<system_event ${received}>\n${e.text}\n</system_event>`
      : `<telegram_message ${received}${e.queued ? ' queued="yes"' : ''}>\n${e.text}\n</telegram_message>`;
  };
  return [
    ...entries.map(message),
    `<pending_subagent_questions>\n${pendingQuestions}\n</pending_subagent_questions>`,
    `<order_state>\n${orderState}\n</order_state>`,
  ].join('\n\n');
}

/** The end-of-turn marker (with stray punctuation or case), or no text at all. */
export function isEndOfTurn(text: string): boolean {
  const t = text.trim().replace(/[.!]+$/, '').toLowerCase();
  return t === '' || t === END_OF_TURN;
}

/** Single-consumer queue; a waiting takeAll() is released with undefined when its signal aborts. */
class Inbox<T> {
  private readonly items: T[] = [];
  private wake: (() => void) | undefined;

  push(item: T): void {
    this.items.push(item);
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  /** Everything queued, waiting for at least one item. */
  takeAll(signal: AbortSignal): Promise<T[] | undefined> {
    if (this.items.length > 0) return Promise.resolve(this.items.splice(0));
    if (signal.aborted) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const onAbort = () => {
        if (this.wake === deliver) this.wake = undefined;
        resolve(undefined);
      };
      const deliver = () => {
        signal.removeEventListener('abort', onAbort);
        resolve(this.items.splice(0));
      };
      this.wake = deliver;
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
