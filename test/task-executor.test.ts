/**
 * LongLivedExecutor keep-alive: a long silent run publishes WORKING beats so the client's SSE stream
 * (Node fetch drops a body after 300 s without data) stays open; a task parked on a question stays quiet.
 */
import type { AgentExecutionEvent, ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Telemetry } from '../src/observability/telemetry.js';
import { makeMessage, Role, TaskState, textPart } from '../src/shared/a2a.js';
import { LongLivedExecutor, type TaskOutcome, type TaskRunContext } from '../src/shared/task-executor.js';

class ScriptedExecutor extends LongLivedExecutor {
  constructor(private readonly work: (ctx: TaskRunContext) => Promise<TaskOutcome>) {
    super('execute', new Telemetry('execute'));
  }

  protected run(ctx: TaskRunContext): Promise<TaskOutcome> {
    return this.work(ctx);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const MINUTE = 60_000;
const OUTCOME: TaskOutcome = { summary: 'done', result: { ok: true }, artifactName: 'result' };

describe('LongLivedExecutor heartbeat', () => {
  let events: AgentExecutionEvent[];
  const bus = { publish: (e: AgentExecutionEvent) => events.push(e) } as unknown as ExecutionEventBus;
  const request = { taskId: 't1', contextId: 'c1', userMessage: makeMessage(Role.ROLE_USER, [textPart('go')]) } as unknown as RequestContext;
  /** WORKING status updates without a message, i.e. heartbeats. */
  const beats = () =>
    events.filter((e) => e.kind === 'statusUpdate' && e.data.status?.state === TaskState.TASK_STATE_WORKING && !e.data.status.message).length;

  beforeEach(() => {
    events = [];
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('beats once a minute while the run is silent and stops when it finishes', async () => {
    const work = deferred<TaskOutcome>();
    const executor = new ScriptedExecutor(() => work.promise);
    const running = executor.execute(request, bus);

    vi.advanceTimersByTime(3 * MINUTE);
    expect(beats()).toBe(3);

    work.resolve(OUTCOME);
    await running;
    const last = events.at(-1);
    expect(last?.kind === 'statusUpdate' && last.data.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    vi.advanceTimersByTime(3 * MINUTE);
    expect(beats()).toBe(3);
  });

  it('stays quiet while the task waits for the user', async () => {
    const executor = new ScriptedExecutor(async (ctx) => {
      await ctx.ask('Which one?');
      return OUTCOME;
    });
    const running = executor.execute(request, bus);
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'statusUpdate' && e.data.status?.state === TaskState.TASK_STATE_INPUT_REQUIRED)).toBe(true));

    vi.advanceTimersByTime(5 * MINUTE);
    expect(beats()).toBe(0);

    await executor.cancelTask('t1', bus);
    await running;
    vi.advanceTimersByTime(2 * MINUTE);
    expect(beats()).toBe(0);
  });
});

describe('LongLivedExecutor shutdown', () => {
  const states = (events: AgentExecutionEvent[]) =>
    events.flatMap((e) => (e.kind === 'statusUpdate' && e.data.status ? [e.data.status.state] : []));
  const requestFor = (taskId: string) =>
    ({ taskId, contextId: 'c1', userMessage: makeMessage(Role.ROLE_USER, [textPart('go')]) }) as unknown as RequestContext;

  it('cancels running and waiting tasks and waits for their cleanup before the process exits', async () => {
    const events: AgentExecutionEvent[] = [];
    const bus = { publish: (e: AgentExecutionEvent) => events.push(e) } as unknown as ExecutionEventBus;
    const cleaned: string[] = [];
    const executor = new ScriptedExecutor(async (ctx) => {
      try {
        if (ctx.taskId === 'parked') await ctx.ask('Which one?');
        else await new Promise((_resolve, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true }));
        return OUTCOME;
      } finally {
        await new Promise((r) => setTimeout(r, 20)); // e.g. stopping the agent-browser daemon
        cleaned.push(ctx.taskId);
      }
    });
    const parked = executor.execute(requestFor('parked'), bus);
    const running = executor.execute(requestFor('running'), bus);
    await vi.waitFor(() => expect(states(events)).toContain(TaskState.TASK_STATE_INPUT_REQUIRED));

    await executor.shutdown(2_000);
    expect(cleaned.sort()).toEqual(['parked', 'running']);
    await Promise.all([parked, running]);
    expect(states(events).filter((s) => s === TaskState.TASK_STATE_CANCELED)).toHaveLength(2);
  });
});
