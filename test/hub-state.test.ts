import { describe, expect, it } from 'vitest';
import type { ObsEvent } from '../src/observability/events.js';
import {
  deriveAgents,
  deriveTasks,
  EventBuffer,
  OFFLINE_AFTER_MS,
  parseEventQuery,
  queryEvents,
} from '../src/observability/hub/state.js';

let seq = 0;
const T0 = Date.parse('2026-10-08T10:00:00.000Z');

function ev(agent: string, kind: ObsEvent['kind'], data: Record<string, unknown>, extra: Partial<ObsEvent> = {}): ObsEvent {
  seq += 1;
  return { id: `e${seq}`, ts: new Date(T0 + seq * 1000).toISOString(), agent, kind, data, ...extra };
}

describe('EventBuffer', () => {
  it('keeps only the newest events up to capacity', () => {
    const buf = new EventBuffer(3);
    buf.push([ev('cos', 'log', {}), ev('cos', 'log', {})]);
    buf.push([ev('cos', 'log', { n: 3 }), ev('cos', 'log', { n: 4 })]);
    expect(buf.size).toBe(3);
    expect(buf.all().at(-1)?.data).toEqual({ n: 4 });
  });
});

describe('queryEvents', () => {
  const events = [
    ev('cos', 'telegram', { direction: 'in', text: 'order' }),
    ev('explore', 'a2a', { direction: 'receive', from: 'cos' }, { taskId: 't1', contextId: 'c1' }),
    ev('explore', 'tool_call', { tool: 'Skill' }, { taskId: 't1', contextId: 'c1' }),
    ev('execute', 'tool_call', { tool: 'mcp__playwright__browser_click' }, { taskId: 't2', contextId: 'c2' }),
  ];

  it('filters by agent list, kind list, taskId and contextId', () => {
    expect(queryEvents(events, parseEventQuery({ agent: 'explore,execute', kind: 'tool_call' })).map((e) => e.agent)).toEqual([
      'explore',
      'execute',
    ]);
    expect(queryEvents(events, parseEventQuery({ taskId: 't1' }))).toHaveLength(2);
    expect(queryEvents(events, parseEventQuery({ contextId: 'c2' }))[0]?.agent).toBe('execute');
  });

  it('applies since (exclusive) and returns the newest `limit` events oldest first', () => {
    expect(queryEvents(events, parseEventQuery({ since: events[1]!.ts })).map((e) => e.id)).toEqual([events[2]!.id, events[3]!.id]);
    expect(queryEvents(events, parseEventQuery({ limit: '2' })).map((e) => e.id)).toEqual([events[2]!.id, events[3]!.id]);
  });

  it('clamps bad limits', () => {
    expect(parseEventQuery({ limit: 'abc' }).limit).toBe(500);
    expect(parseEventQuery({ limit: '0' }).limit).toBe(1);
    expect(parseEventQuery({ limit: '999999' }).limit).toBe(5000);
  });
});

describe('deriveAgents', () => {
  it('lists every known agent, offline until its first event', () => {
    const agents = deriveAgents([]);
    expect(agents.map((a) => a.agent)).toEqual(['cos', 'explore', 'execute', 'qa']);
    expect(agents.every((a) => a.state === 'offline')).toBe(true);
  });

  it('derives state, current task, activity, counts and cost', () => {
    const events = [
      ev('execute', 'status', { state: 'idle', detail: 'ready' }),
      ev('execute', 'status', { state: 'busy', detail: 'adding items' }, { taskId: 't9', contextId: 'c9' }),
      ev('execute', 'tool_call', { tool: 'mcp__playwright__browser_navigate', toolUseId: 'u1' }),
      ev('execute', 'tool_result', { tool: 'mcp__playwright__browser_navigate', toolUseId: 'u1', ok: true }),
      ev('execute', 'tool_call', { tool: 'mcp__playwright__browser_click', toolUseId: 'u2' }),
      ev('execute', 'tool_result', { tool: 'mcp__playwright__browser_click', toolUseId: 'u2', ok: false }),
      ev('execute', 'error', { message: 'boom' }),
      // Per-block model events carry no tokens any more; old ones are ignored.
      ev('execute', 'llm', { inputTokens: 100, outputTokens: 20 }),
      // Two results of one streaming session (running totals) + one separate run.
      ev('execute', 'run', { costUsd: 0.1, inputTokens: 100, outputTokens: 20 }, { sessionId: 's1' }),
      ev('execute', 'run', { costUsd: 0.25, inputTokens: 130, outputTokens: 22 }, { sessionId: 's1' }),
      ev('execute', 'run', { costUsd: 0.05, inputTokens: 20, outputTokens: 3 }, { sessionId: 's2' }),
    ];
    const now = Date.parse(events.at(-1)!.ts);
    const execute = deriveAgents(events, now).find((a) => a.agent === 'execute')!;
    expect(execute).toMatchObject({
      state: 'busy',
      detail: 'adding items',
      taskId: 't9',
      contextId: 'c9',
      activity: 'tool: mcp__playwright__browser_click',
      toolCalls: 2,
      toolErrors: 1,
      errors: 1,
      inputTokens: 150,
      outputTokens: 25,
    });
    expect(execute.costUsd).toBeCloseTo(0.3);
  });

  it('drops the current task once the agent is idle again and shows the status detail as activity', () => {
    const events = [
      ev('qa', 'status', { state: 'busy', detail: 'checking' }, { taskId: 't1' }),
      ev('qa', 'tool_call', { tool: 'mcp__agent_browser__agent_browser_open' }),
      ev('qa', 'status', { state: 'idle', detail: 'task completed' }, { taskId: 't1' }),
    ];
    const qa = deriveAgents(events, Date.parse(events.at(-1)!.ts)).find((a) => a.agent === 'qa')!;
    expect(qa.state).toBe('idle');
    expect(qa.taskId).toBeUndefined();
    expect(qa.activity).toBe('task completed');
  });

  it('marks a busy agent offline after long silence, but not an idle one', () => {
    const events = [ev('explore', 'status', { state: 'busy' }), ev('qa', 'status', { state: 'idle' })];
    const later = Date.parse(events[1]!.ts) + OFFLINE_AFTER_MS + 1;
    const agents = deriveAgents(events, later);
    expect(agents.find((a) => a.agent === 'explore')!.state).toBe('offline');
    expect(agents.find((a) => a.agent === 'qa')!.state).toBe('idle');
  });

  it('adds cards for agents outside the known set', () => {
    expect(deriveAgents([ev('launcher', 'log', { text: 'hi' })]).map((a) => a.agent)).toContain('launcher');
  });
});

describe('deriveTasks', () => {
  it('builds one row per task with the sub-agent as owner and the latest state', () => {
    const ids = { taskId: 't1', contextId: 'c1' };
    const events = [
      ev('cos', 'a2a', { direction: 'send', to: 'explore', text: 'select products' }, ids),
      ev('explore', 'a2a', { direction: 'receive', from: 'cos', text: 'select products' }, ids),
      ev('explore', 'a2a', { direction: 'send', to: 'cos', state: 'input-required', text: 'Which products?' }, ids),
      ev('cos', 'a2a', { direction: 'send', to: 'explore', text: '1 - 2' }, ids),
      ev('explore', 'a2a', { direction: 'send', to: 'cos', state: 'completed', text: 'Selected 1 product' }, ids),
      ev('cos', 'a2a', { direction: 'send', to: 'execute', text: 'fill basket' }, { taskId: 't2', contextId: 'c1' }),
      ev('cos', 'telegram', { direction: 'out', text: 'not an a2a event' }, ids),
    ];
    const tasks = deriveTasks(events);
    expect(tasks.map((t) => t.taskId)).toEqual(['t2', 't1']);
    expect(tasks[1]).toMatchObject({
      agent: 'explore',
      contextId: 'c1',
      state: 'completed',
      messages: 5,
      lastText: 'Selected 1 product',
      firstTs: events[0]!.ts,
      lastTs: events[4]!.ts,
    });
    expect(tasks[0]).toMatchObject({ agent: 'execute', state: 'submitted' });
  });
});
