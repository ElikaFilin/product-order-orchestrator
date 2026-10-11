/**
 * Every rule the agents must follow, enforced in code:
 *  - each agent calls only its own tools (deny the rest), Explore reads only its skill file;
 *  - COS starts only tasks it created with poo_task, and the plugin writes the child's task text;
 *  - COS talks only to the owner's chat; questions are relayed verbatim (@relay), answers go back verbatim to the
 *    same child session (sessions_send), and the basket link goes out only once QA verified the basket;
 *  - Playwright calls pass the shop guard (QA: read-only) in the run's own tab, page scripts get the shop helper,
 *    foreign tabs are hidden in results, and what the page returned is captured for the submit tools.
 */
import path from 'node:path';
import type { SubAgentName } from '../core/agents.js';
import { createBrowserGuard, parseHelperCall, type HelperCall, type ToolGuard } from '../core/browser/guard.js';
import { createTabRedactor } from '../core/browser/redact.js';
import { browserToolNames, browserToolset, toolResultValue } from '../core/browser/toolset.js';
import { errorMessage } from '../core/errors.js';
import { PageOps } from '../core/execute/result.js';
import { PageReads } from '../core/qa/report.js';
import { readOnlyBasketGuard } from '../core/qa/guard.js';
import { getShop } from '../core/shops/index.js';
import { CART_LINK_PLACEHOLDER, cosContext, nextStep, RELAY_PREFIX, taskReport } from './cos.js';
import type {
  BeforeToolCallResult,
  PluginHost,
  ToolCallEvent,
  ToolHookContext,
  ToolResult,
  ToolResultMiddlewareContext,
} from './host.js';
import type { Runtime } from './runtime.js';
import type { TaskRecord } from './store.js';
import { answerMessage, spawnTaskText } from './task-text.js';
import { cancelActive, CHILD_TOOLS, COS_MEMORY_TOOLS, COS_TOOLS, settleEndedRun } from './tools.js';

/** OpenClaw tools COS needs besides ours: talking, sub-agents, and its memory file (read/write/edit only MEMORY.md). */
const COS_CORE_TOOLS = ['message', 'sessions_spawn', 'sessions_yield', 'sessions_send', 'subagents', ...COS_MEMORY_TOOLS];

export function agentTools(rt: Runtime): Record<'cos' | SubAgentName, ReadonlySet<string>> {
  const prefix = rt.config.browserToolPrefix;
  const childTools = (agent: SubAgentName) => Object.entries(CHILD_TOOLS).filter(([, agents]) => (agents as readonly string[]).includes(agent)).map(([name]) => name);
  return {
    cos: new Set([...COS_CORE_TOOLS, ...COS_TOOLS]),
    explore: new Set(['read', ...childTools('explore')]),
    execute: new Set([...browserToolNames('execute').map((t) => `${prefix}${t}`), ...childTools('execute')]),
    qa: new Set([...browserToolNames('qa').map((t) => `${prefix}${t}`), ...childTools('qa')]),
  };
}

const TASK_LABEL = /^poo-((?:explore|execute|qa)-[0-9a-f]{8})(?:-\d+)?$/;
const TASK_ID = /\b(?:explore|execute|qa)-[0-9a-f]{8}\b/;

const block = (blockReason: string): BeforeToolCallResult => ({ block: true, blockReason });

export function registerHooks(host: PluginHost, rt: Runtime): void {
  const { store, settings, config } = rt;
  const tools = agentTools(rt);
  const prefix = config.browserToolPrefix;
  const ourAgent = (id: string | undefined): id is keyof typeof tools => id !== undefined && id in tools;

  // ---------- before_tool_call ----------

  host.on('before_tool_call', async (event, ctx) => {
    const agent = ctx.agentId;
    if (!ourAgent(agent)) return undefined;
    if (!tools[agent].has(event.toolName)) return block(`${event.toolName} is not available to the ${agent} agent.`);
    try {
      if (event.toolName.startsWith(prefix)) return browserCall(event, ctx);
      switch (event.toolName) {
        case 'sessions_spawn':
          return await spawnCall(event);
        case 'sessions_send':
          return sendCall(event, ctx);
        case 'message':
          return messageCall(event, ctx);
        case 'read':
          return agent === 'cos' ? memoryFileCall(event) : readCall(event);
        case 'write':
        case 'edit':
          return memoryFileCall(event);
        default:
          return undefined;
      }
    } catch (err) {
      return block(`Blocked: ${errorMessage(err)}`);
    }
  });

  /** COS names a task it created; the plugin writes everything else. */
  async function spawnCall(event: ToolCallEvent): Promise<BeforeToolCallResult> {
    const named = String(event.params.task ?? '').match(TASK_ID)?.[0];
    const task = named ? store.task(named) : undefined;
    if (!task) return block('Create the task with poo_task first, then sessions_spawn {"agentId": <agent>, "task": <taskId>}.');
    if (event.params.agentId !== task.agent) return block(`Task ${task.id} belongs to the ${task.agent} agent: use agentId "${task.agent}".`);
    if (task.state !== 'created' && task.state !== 'answered') return block(`Task ${task.id} is ${task.state}. ${nextStep(store, task, settings)}`);
    const text = await spawnTaskText(task, {
      productList: rt.productList,
      browserMode: config.browserMode,
      browserToolPrefix: prefix,
      fillOrderForm: config.checkout !== undefined,
    });
    const spawns = store.update(() => store.touch(task, { spawns: task.spawns + 1 }).spawns);
    return {
      params: {
        agentId: task.agent,
        task: text,
        label: `poo-${task.id}-${spawns}`,
        mode: 'run',
        cleanup: 'keep',
        completionTarget: 'parent',
        context: 'isolated',
        runTimeoutSeconds: settings.runTimeoutSeconds[task.agent],
      },
    };
  }

  /** Only the stored answer, only to the session that asked. */
  function sendCall(event: ToolCallEvent, ctx: ToolHookContext): BeforeToolCallResult {
    const sessionKey = String(event.params.sessionKey ?? '').trim();
    const task = store.taskBySession(sessionKey);
    if (!task) return block('sessions_send only gives a sub-agent the user\'s answer: use the sessionKey of the task (see its next step).');
    const q = store.openQuestion(task);
    if (task.state !== 'answered' || q?.answer === undefined) return block(`Task ${task.id} is ${task.state}. ${nextStep(store, task, settings)}`);
    store.update(() => {
      q.deliveredAt = store.timestamp();
      store.touch(task, { state: 'running' });
    });
    rt.sends.set(callId(event, ctx), task.id);
    return { params: { sessionKey, message: answerMessage(task, q.answer), timeoutSeconds: settings.runTimeoutSeconds[task.agent] } };
  }

  /** Plain text to the owner's chat; @relay and {{cart_link}} are filled in here. */
  function messageCall(event: ToolCallEvent, ctx: ToolHookContext): BeforeToolCallResult {
    const p = event.params;
    const action = p.action ?? 'send';
    if (action !== 'send') return block('Only action "send" is available: plain text messages to the user.');
    const extra = Object.keys(p).filter((k) => !['action', 'message', 'text', 'content', 'channel', 'target', 'to', 'final', 'silent'].includes(k));
    if (extra.length) return block(`Only plain text to the user: remove ${extra.join(', ')}.`);
    if (p.channel !== undefined && p.channel !== 'telegram') return block('Messages go only to the user\'s Telegram chat.');
    for (const key of ['target', 'to'] as const) {
      if (p[key] !== undefined && !isOwner(String(p[key]))) return block("Messages go only to the user's chat: leave out the target.");
    }
    let body = String(p.message ?? p.text ?? p.content ?? '');
    const relayed = body.trim().startsWith(RELAY_PREFIX) ? body.trim().slice(RELAY_PREFIX.length).trim() : undefined;
    if (relayed !== undefined) {
      const task = store.task(relayed);
      const q = task && store.openQuestion(task);
      if (!task || task.state !== 'input-required' || !q) return block(`No question waits for the user in task ${relayed}.`);
      body = q.question;
      rt.relays.set(callId(event, ctx), task.id);
    } else if (body.includes(RELAY_PREFIX)) {
      return block(`Send ${RELAY_PREFIX}<taskId> alone: the plugin replaces the whole message with the question.`);
    }
    const verified = store.order.isVerified();
    if (body.includes(CART_LINK_PLACEHOLDER)) {
      if (!verified) return block(`The basket is not verified yet, so the link cannot be sent. ${store.order.summary()}`);
      body = body.replaceAll(CART_LINK_PLACEHOLDER, settings.cartUrl);
    } else if (mentionsCartLink(body) && !verified) {
      return block('The basket link goes out only after QA verified the basket (then write {{cart_link}}).');
    }
    if (!body.trim()) return block('The message is empty.');
    return { params: { action: 'send', message: body, ...(p.final !== undefined ? { final: p.final } : {}), ...(p.silent !== undefined ? { silent: p.silent } : {}) } };
  }

  /** Explore reads its skill file and nothing else. */
  function readCall(event: ToolCallEvent): BeforeToolCallResult | undefined {
    const workspace = path.dirname(path.dirname(path.dirname(config.skillFile)));
    if (isFile(event, workspace, config.skillFile)) return undefined;
    return block(`Only your skill file can be read: ${path.relative(workspace, config.skillFile)}.`);
  }

  /** COS reads and changes its memory file and nothing else. */
  function memoryFileCall(event: ToolCallEvent): BeforeToolCallResult | undefined {
    const file = config.memoryFile;
    if (!file) return block('No memory file is set up.');
    if (isFile(event, path.dirname(file), file)) return undefined;
    return block(`Only your memory file can be read or changed: ${path.basename(file)}.`);
  }

  /** The shop guard of the run's own tab; QA is read-only. */
  function browserCall(event: ToolCallEvent, ctx: ToolHookContext): BeforeToolCallResult | undefined {
    const task = store.taskBySession(ctx.sessionKey);
    if (!task || task.agent !== ctx.agentId || task.state !== 'running') return block('The browser is only for a running Execute or QA task.');
    const key = `${ctx.sessionKey}|${ctx.runId ?? event.runId ?? ''}`;
    let guard = rt.guards.get(key);
    if (!guard) {
      guard = runGuard(rt, task);
      rt.guards.set(key, guard);
    }
    const decision = guard(event.toolName, event.params);
    if (decision?.deny) return block(decision.deny);
    if (event.toolName === `${prefix}browser_evaluate`) {
      const call = parseHelperCall(String(event.params.function ?? ''));
      if (call) rt.helperCalls.set(callId(event, ctx), { taskId: task.id, call });
    }
    return decision?.updatedInput ? { params: decision.updatedInput } : undefined;
  }

  // ---------- tool results ----------

  host.registerAgentToolResultMiddleware(
    (event, ctx) => {
      if (event.toolName.startsWith(prefix)) return browserResult(event.toolName, take(rt.helperCalls, event.toolCallId, ctx), event.result);
      switch (event.toolName) {
        case 'sessions_spawn': {
          const spawned = parseJson(event.result);
          bindSpawn(String(event.args.label ?? ''), spawned.childSessionKey, spawned.runId);
          return undefined;
        }
        case 'message': {
          const taskId = take(rt.relays, event.toolCallId, ctx);
          const task = taskId ? store.task(taskId) : undefined;
          const q = task && store.openQuestion(task);
          if (q && !event.isError) store.update(() => (q.relayedAt = store.timestamp()));
          return undefined;
        }
        case 'sessions_send':
          return sendResult(take(rt.sends, event.toolCallId, ctx), event.result, event.isError === true);
        default:
          return undefined;
      }
    },
    { runtimes: ['openclaw'] },
  );

  function browserResult(
    toolName: string,
    pending: { taskId: string; call: HelperCall } | undefined,
    result: ToolResult,
  ): { result: ToolResult } | undefined {
    const task = pending ? store.task(pending.taskId) : undefined;
    if (pending && task) {
      const value = toolResultValue(result.content);
      if (task.agent === 'execute') pageOps(task).record(pending.call, value);
      else pageReads(task).record(pending.call.method, value);
    }
    const shop = getShop(config.shopId);
    const redacted = createTabRedactor(shop, { prefix })(toolName, result.content);
    return redacted ? { result: { ...result, content: redacted as ToolResult['content'] } } : undefined;
  }

  /** The child finished the continued run (or the call failed): COS gets the task's report with its next step. */
  function sendResult(taskId: string | undefined, result: ToolResult, isError: boolean): { result: ToolResult } | undefined {
    const task = taskId ? store.task(taskId) : undefined;
    if (!task) return undefined;
    const outcome = parseJson(result);
    const status = String(outcome.status ?? (isError ? 'error' : ''));
    store.update(() => {
      if (status === 'ok' || status === 'no_reply') {
        settleEndedRun(rt, task, { ok: true });
      } else if (status !== 'accepted' && task.state === 'running') {
        // Not delivered: the answer stays stored, and the task can continue in a new session.
        const q = task.questions.at(-1);
        if (q) delete q.deliveredAt;
        store.touch(task, { state: 'answered' });
      }
    });
    const report = { ...taskReport(store, task, settings), sessions_send: status || 'unknown', ...(outcome.reply ? { reply: outcome.reply } : {}) };
    return { result: { ...result, content: [{ type: 'text', text: JSON.stringify(report, null, 1) }] } };
  }

  function pageOps(task: TaskRecord): PageOps {
    let ops = rt.pageOps.get(task.id);
    if (!ops) rt.pageOps.set(task.id, (ops = new PageOps()));
    return ops;
  }

  function pageReads(task: TaskRecord): PageReads {
    let reads = rt.pageReads.get(task.id);
    if (!reads) rt.pageReads.set(task.id, (reads = new PageReads()));
    return reads;
  }

  // ---------- sub-agent lifecycle ----------

  /** A child session now works on the task named by the spawn label. */
  function bindSpawn(label: string, childSessionKey: unknown, runId: unknown): void {
    const taskId = label.match(TASK_LABEL)?.[1];
    const task = taskId ? store.task(taskId) : undefined;
    if (!task || typeof childSessionKey !== 'string' || task.childSessionKey === childSessionKey) return;
    store.update(() => {
      const q = store.openQuestion(task);
      if (task.state === 'answered' && q) q.deliveredAt = store.timestamp(); // the new task text carries the answer
      store.touch(task, { childSessionKey, ...(typeof runId === 'string' ? { runId } : {}), state: 'running' });
    });
  }

  host.on('subagent_spawned', (event) => bindSpawn(event.label ?? '', event.childSessionKey, event.runId));

  host.on('subagent_ended', (event) => {
    const task = store.taskBySession(event.targetSessionKey);
    if (!task || task.state !== 'running') return;
    if (event.runId && task.runId && event.runId !== task.runId) return;
    store.update(() => {
      if (event.outcome === 'killed' || event.outcome === 'reset' || event.outcome === 'deleted') store.touch(task, { state: 'canceled' });
      else settleEndedRun(rt, task, { ok: event.outcome === undefined || event.outcome === 'ok', error: event.error ?? event.outcome });
    });
  });

  // ---------- COS's context, outgoing messages, /new ----------

  // OpenClaw creates no persona files for us (skipBootstrap), and a missing SOUL.md or IDENTITY.md would still reach
  // the prompt as a "[MISSING] Expected at: ..." line. Only files that exist are injected.
  host.registerHook(
    'agent:bootstrap',
    (event) => {
      const files = event.context.bootstrapFiles;
      if (!ourAgent(String(event.context.agentId ?? '')) || !Array.isArray(files)) return;
      event.context.bootstrapFiles = files.filter((file: { missing?: boolean }) => file.missing !== true);
    },
    { name: 'product-order-orchestrator-bootstrap', description: 'Leave missing workspace files out of the prompts of our agents.' },
  );

  host.on('before_prompt_build', (_event, ctx) => {
    if (!ourAgent(ctx.agentId)) return undefined;
    const visible = [...tools[ctx.agentId]];
    return ctx.agentId === 'cos' ? { appendContext: cosContext(store, settings), toolsAllow: visible } : { toolsAllow: visible };
  });

  /** Second line behind the message hook: every outgoing Telegram message, whatever produced it. */
  host.on('message_sending', (event, ctx) => {
    if (ctx.channelId !== 'telegram') return undefined;
    if (!isOwner(event.to)) return { cancel: true, cancelReason: 'only the owner chat' };
    if (mentionsCartLink(event.content) && !store.order.isVerified()) return { cancel: true, cancelReason: 'basket not verified' };
    return undefined;
  });

  host.on('before_reset', (_event, ctx) => {
    if (ctx.agentId !== 'cos') return;
    store.update(() => {
      cancelActive(rt);
      store.order.reset();
    });
  });

  function isOwner(target: string): boolean {
    const id = config.telegramUserId;
    return [id, `telegram:${id}`, `tg:${id}`].includes(target.trim());
  }

  /** The basket link, with or without the scheme; for a link with a fragment (#opencart) the fragment alone. */
  function mentionsCartLink(text: string): boolean {
    const url = new URL(settings.cartUrl);
    return text.includes(`${url.host}${url.pathname}${url.search}${url.hash}`) || (url.hash.length > 1 && text.includes(url.hash));
  }
}

/** The file tool's path (relative to the agent's workspace, or absolute) is exactly `file`. */
function isFile(event: ToolCallEvent, workspace: string, file: string): boolean {
  const raw = String(event.params.path ?? event.params.file_path ?? event.params.filePath ?? '').trim();
  return raw !== '' && path.resolve(workspace, raw) === path.resolve(file);
}

function runGuard(rt: Runtime, task: TaskRecord): ToolGuard {
  const shop = getShop(task.request.shopId);
  const role = task.agent === 'qa' ? 'qa' : 'execute';
  const toolset = browserToolset({ role, mode: rt.config.browserMode, prefix: rt.config.browserToolPrefix });
  if (role === 'qa') return readOnlyBasketGuard(toolset, shop, createBrowserGuard(shop, toolset));
  return createBrowserGuard(shop, toolset, rt.config.checkout ? { checkout: rt.config.checkout } : {});
}

/** Tool call id, or the run's sequential slot when OpenClaw does not give one (calls of one run are sequential). */
function callId(event: ToolCallEvent, ctx: ToolHookContext): string {
  return event.toolCallId ?? ctx.toolCallId ?? runSlot(ctx.sessionKey, ctx.runId ?? event.runId);
}

function runSlot(sessionKey: string | undefined, runId: string | undefined): string {
  return `${sessionKey}|${runId ?? ''}|last`;
}

/** The entry a before_tool_call left for this call, removed from the map. */
function take<T>(map: Map<string, T>, toolCallId: string, ctx: ToolResultMiddlewareContext): T | undefined {
  for (const key of [toolCallId, runSlot(ctx.sessionKey, ctx.runId)]) {
    const value = map.get(key);
    if (value !== undefined) {
      map.delete(key);
      return value;
    }
  }
  return undefined;
}

function parseJson(result: ToolResult): Record<string, unknown> {
  const block = result.content.find((c) => c.type === 'text');
  const raw = block?.type === 'text' ? block.text : '';
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
