/**
 * Pure state of the dashboard hub: the in-memory event buffer, event queries and the views derived
 * from the event stream (agent board, A2A task list). No I/O here, so every rule is unit-testable.
 */
import { SUB_AGENTS } from '../../config/agents.js';
import type { AgentState, ObsEvent } from '../events.js';

/** Agents that always get a card on the board, even before their first event. */
export const KNOWN_AGENTS: readonly string[] = ['cos', ...SUB_AGENTS];

/**
 * A busy/starting agent that has been silent this long is shown as offline: a working agent emits
 * tool calls and model turns continuously, so long silence means the process died without saying so.
 */
export const OFFLINE_AFTER_MS = 10 * 60_000;

export const DEFAULT_QUERY_LIMIT = 500;
export const MAX_QUERY_LIMIT = 5_000;

/** Fixed-capacity buffer that keeps the most recent events in arrival order. */
export class EventBuffer {
  private events: ObsEvent[] = [];

  constructor(readonly capacity: number) {}

  push(events: readonly ObsEvent[]): void {
    this.events.push(...events);
    const excess = this.events.length - this.capacity;
    if (excess > 0) this.events.splice(0, excess);
  }

  all(): readonly ObsEvent[] {
    return this.events;
  }

  get size(): number {
    return this.events.length;
  }
}

export interface EventQuery {
  limit: number;
  /** Only events with a timestamp strictly after this ISO time. */
  since?: string;
  agents?: string[];
  kinds?: string[];
  taskId?: string;
  contextId?: string;
}

/** Parse GET /api/events query parameters. Lists are comma-separated (`agent=cos,qa`). */
export function parseEventQuery(params: Record<string, unknown>): EventQuery {
  const str = (key: string): string | undefined => {
    const v = params[key];
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
  };
  const list = (key: string): string[] | undefined => str(key)?.split(',').map((s) => s.trim()).filter(Boolean);
  const limit = Number(str('limit') ?? DEFAULT_QUERY_LIMIT);
  return {
    limit: Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), MAX_QUERY_LIMIT) : DEFAULT_QUERY_LIMIT,
    since: str('since'),
    agents: list('agent'),
    kinds: list('kind'),
    taskId: str('taskId'),
    contextId: str('contextId'),
  };
}

/** The newest `limit` events matching the query, oldest first. */
export function queryEvents(events: readonly ObsEvent[], q: EventQuery): ObsEvent[] {
  const sinceMs = q.since === undefined ? undefined : Date.parse(q.since);
  const matches = events.filter(
    (e) =>
      (sinceMs === undefined || Number.isNaN(sinceMs) || Date.parse(e.ts) > sinceMs) &&
      (!q.agents || q.agents.includes(e.agent)) &&
      (!q.kinds || q.kinds.includes(e.kind)) &&
      (!q.taskId || e.taskId === q.taskId) &&
      (!q.contextId || e.contextId === q.contextId),
  );
  return matches.slice(-q.limit);
}

// ---------- agent board ----------

export type DisplayState = AgentState | 'offline';

export interface AgentSummary {
  agent: string;
  state: DisplayState;
  /** Detail of the last status event (what the agent said it is doing). */
  detail?: string;
  stateTs?: string;
  lastSeen?: string;
  /** Most recent thing the agent did: its last tool call if newer than its last status, else the status detail. */
  activity?: string;
  /** Task the agent is working on (only while busy or waiting for input). */
  taskId?: string;
  contextId?: string;
  toolCalls: number;
  toolErrors: number;
  errors: number;
  /** Tokens and estimated spend from 'run' events (latest running total per Agent SDK session, summed). */
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

interface RunTotals {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

interface AgentAccumulator {
  summary: AgentSummary;
  lastStatus?: ObsEvent;
  lastToolCall?: ObsEvent;
  totalsBySession: Map<string, RunTotals>;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const isNewer = (e: ObsEvent, than: ObsEvent | undefined) => !than || Date.parse(e.ts) >= Date.parse(than.ts);

function emptySummary(agent: string): AgentSummary {
  return { agent, state: 'offline', toolCalls: 0, toolErrors: 0, errors: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
}

export function deriveAgents(events: readonly ObsEvent[], now: number = Date.now()): AgentSummary[] {
  const acc = new Map<string, AgentAccumulator>();
  const get = (agent: string): AgentAccumulator => {
    let a = acc.get(agent);
    if (!a) {
      a = { summary: emptySummary(agent), totalsBySession: new Map() };
      acc.set(agent, a);
    }
    return a;
  };
  for (const agent of KNOWN_AGENTS) get(agent);

  for (const e of events) {
    const a = get(e.agent);
    const s = a.summary;
    if (!s.lastSeen || Date.parse(e.ts) > Date.parse(s.lastSeen)) s.lastSeen = e.ts;
    switch (e.kind) {
      case 'status':
        if (isNewer(e, a.lastStatus)) a.lastStatus = e;
        break;
      case 'tool_call':
        s.toolCalls += 1;
        if (isNewer(e, a.lastToolCall)) a.lastToolCall = e;
        break;
      case 'tool_result':
        if (e.data.ok === false) s.toolErrors += 1;
        break;
      case 'error':
        s.errors += 1;
        break;
      case 'run':
        // Cost and tokens are running totals within one Agent SDK session: keep the latest per session.
        // ('llm' events carry no tokens: the CLI reports one per content block with the placeholder usage.)
        a.totalsBySession.set(e.sessionId ?? e.id, {
          costUsd: num(e.data.costUsd),
          inputTokens: num(e.data.inputTokens),
          outputTokens: num(e.data.outputTokens),
        });
        break;
    }
  }

  return [...acc.values()].map(({ summary: s, lastStatus, lastToolCall, totalsBySession }) => {
    const runs = [...totalsBySession.values()];
    s.costUsd = runs.reduce((sum, r) => sum + r.costUsd, 0);
    s.inputTokens = runs.reduce((sum, r) => sum + r.inputTokens, 0);
    s.outputTokens = runs.reduce((sum, r) => sum + r.outputTokens, 0);
    if (lastStatus) {
      s.state = (str(lastStatus.data.state) as AgentState | undefined) ?? 'idle';
      s.detail = str(lastStatus.data.detail);
      s.stateTs = lastStatus.ts;
      if (s.state === 'busy' || s.state === 'waiting_input') {
        s.taskId = lastStatus.taskId;
        s.contextId = lastStatus.contextId;
      }
    }
    s.activity =
      lastToolCall && isNewer(lastToolCall, lastStatus) ? `tool: ${str(lastToolCall.data.tool) ?? 'unknown'}` : s.detail;
    const silentMs = s.lastSeen ? now - Date.parse(s.lastSeen) : Infinity;
    if (!s.lastSeen || ((s.state === 'busy' || s.state === 'starting') && silentMs > OFFLINE_AFTER_MS)) {
      s.state = 'offline';
    }
    return s;
  });
}

// ---------- A2A tasks ----------

export interface TaskSummary {
  taskId: string;
  /** The sub-agent that owns the task (COS is always the other side). */
  agent: string;
  contextId?: string;
  /** Last known A2A task state, e.g. working, input-required, completed, failed, canceled. */
  state: string;
  firstTs: string;
  lastTs: string;
  messages: number;
  lastText?: string;
}

/** The sub-agent side of an A2A event: COS reports `to`/`from`, sub-agents report themselves. */
function taskOwner(e: ObsEvent): string {
  if (e.agent !== 'cos') return e.agent;
  return str(e.data.to) ?? str(e.data.from) ?? 'unknown';
}

/** A2A tasks seen in 'a2a' events, most recently updated first. */
export function deriveTasks(events: readonly ObsEvent[]): TaskSummary[] {
  const tasks = new Map<string, TaskSummary>();
  for (const e of events) {
    if (e.kind !== 'a2a' || !e.taskId) continue;
    let t = tasks.get(e.taskId);
    if (!t) {
      t = { taskId: e.taskId, agent: taskOwner(e), state: 'submitted', firstTs: e.ts, lastTs: e.ts, messages: 0 };
      tasks.set(e.taskId, t);
    }
    t.messages += 1;
    t.contextId ??= e.contextId;
    if (Date.parse(e.ts) < Date.parse(t.firstTs)) t.firstTs = e.ts;
    if (Date.parse(e.ts) >= Date.parse(t.lastTs)) {
      t.lastTs = e.ts;
      t.state = str(e.data.state) ?? t.state;
      t.lastText = str(e.data.text) ?? t.lastText;
    }
  }
  return [...tasks.values()].sort((a, b) => Date.parse(b.lastTs) - Date.parse(a.lastTs));
}
