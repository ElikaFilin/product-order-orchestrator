/**
 * Base A2A executor for LLM sub-agents.
 *
 * One A2A task = one sub-agent run. While the run is going it can ask the human a question
 * (`ctx.ask`): the task goes to INPUT_REQUIRED, COS relays the question to Telegram, and the
 * answer comes back as a follow-up message on the same taskId. The SDK calls execute() again
 * for that follow-up; we hand the answer to the parked run and keep the follow-up call open
 * until the run finishes (verified pattern for @a2a-js/sdk 1.3: returning early drops events).
 */
import { setTimeout as delay } from 'node:timers/promises';
import { AgentEvent, type AgentExecutor, type ExecutionEventBus, type RequestContext } from '@a2a-js/sdk/server';
import type { SubAgentName } from '../config/agents.js';
import type { AgentErrorPayload, ErrorCode, UserQuestion } from './contracts.js';
import { dataOf, dataPart, makeMessage, Role, stateName, TaskState, textOf, textPart, type Part, type Task } from './a2a.js';
import { errorMessage } from './logger.js';
import { SpanKind, type SpanHandle, type Telemetry } from '../observability/telemetry.js';

export class AgentTaskError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'AgentTaskError';
  }
}

export interface TaskRunContext {
  readonly agent: SubAgentName;
  readonly taskId: string;
  readonly contextId: string;
  /** Text parts of the first message (COS instruction). */
  readonly instruction: string;
  /** Data parts of the first message (request payload + forwarded artifacts). */
  readonly data: readonly unknown[];
  readonly signal: AbortSignal;
  readonly span: SpanHandle;
  readonly telemetry: Telemetry;
  /** Ask the human (through COS) and wait for the answer text. */
  ask(question: string, options?: string[]): Promise<string>;
  /** Publish a WORKING status update with a short progress note. */
  progress(text: string): void;
}

export interface TaskOutcome {
  /** Human-readable summary for COS. */
  summary: string;
  /** Structured result (one of the contracts payloads). */
  result: unknown;
  artifactName: string;
}

interface Pending {
  resolve(answer: string): void;
  reject(err: Error): void;
}

interface Session {
  contextId: string;
  abort: AbortController;
  pending?: Pending;
  done: Promise<void>;
  /** A terminal status (completed/failed/canceled) was already published. */
  finished: boolean;
}

const now = () => new Date().toISOString();

/** Node's fetch (undici) drops a response after 300 s without data; a WORKING beat keeps COS's stream open. */
const HEARTBEAT_MS = 60_000;

export abstract class LongLivedExecutor implements AgentExecutor {
  private readonly sessions = new Map<string, Session>();

  constructor(
    protected readonly agent: SubAgentName,
    protected readonly telemetry: Telemetry,
  ) {}

  /** The agent's actual work. Throw AgentTaskError for expected failures. */
  protected abstract run(ctx: TaskRunContext): Promise<TaskOutcome>;

  async execute(rc: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage } = rc;
    const ids = { taskId, contextId };
    const text = textOf(userMessage.parts);
    const session = this.sessions.get(taskId);

    this.telemetry.emit('a2a', { direction: 'receive', from: 'cos', text, data: dataOf(userMessage.parts) }, ids);

    // Follow-up message on an existing task: it must be the answer to a pending question.
    if (rc.task) {
      bus.publish(AgentEvent.task(rc.task)); // a streaming turn must start with the Task snapshot
      if (!session?.pending) {
        this.publishFailure(bus, taskId, contextId, {
          type: 'error',
          code: 'SESSION_LOST',
          message: session
            ? 'This task is not waiting for an answer.'
            : 'The agent no longer has this task in memory (it was restarted). Start a new task.',
        });
        return;
      }
      const pending = session.pending;
      session.pending = undefined;
      this.publishStatus(bus, taskId, contextId, TaskState.TASK_STATE_WORKING, 'Answer received, continuing.');
      this.telemetry.status('busy', 'answer received', ids);
      pending.resolve(text);
      await session.done; // keep this request open until the run publishes its terminal event
      return;
    }

    // New task.
    const initial: Task = {
      id: taskId,
      contextId,
      artifacts: [],
      history: [userMessage],
      metadata: {},
      status: { state: TaskState.TASK_STATE_SUBMITTED, timestamp: now(), message: undefined },
    };
    bus.publish(AgentEvent.task(initial));

    const abort = new AbortController();
    const span = this.telemetry.startSpan(
      `invoke_agent ${this.agent}`,
      {
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.conversation.id': contextId,
        'session.id': contextId,
        'a2a.task_id': taskId,
      },
      typeof userMessage.metadata?.traceparent === 'string' ? userMessage.metadata.traceparent : undefined,
      SpanKind.SERVER,
    );
    const newSession: Session = { contextId, abort, done: Promise.resolve(), finished: false };
    this.sessions.set(taskId, newSession);

    const ctx: TaskRunContext = {
      agent: this.agent,
      taskId,
      contextId,
      instruction: text,
      data: dataOf(userMessage.parts),
      signal: abort.signal,
      span,
      telemetry: this.telemetry,
      ask: (question, options) => this.ask(bus, taskId, newSession, question, options),
      progress: (note) => this.publishStatus(bus, taskId, contextId, TaskState.TASK_STATE_WORKING, note),
    };

    newSession.done = this.runTask(ctx, bus, span, newSession).finally(() => {
      this.sessions.delete(taskId);
    });
    await newSession.done;
  }

  /**
   * Process shutdown: cancel every running or waiting task and wait (at most `timeoutMs`) until their runs
   * have finished, so per-run cleanup (e.g. stopping the agent-browser daemon) happens before the exit.
   * The runs publish their own CANCELED status.
   */
  async shutdown(timeoutMs: number): Promise<void> {
    const sessions = [...this.sessions.values()];
    for (const session of sessions) {
      const reason = new AgentTaskError('CANCELED', 'The agent is shutting down');
      session.abort.abort(reason);
      session.pending?.reject(reason);
      session.pending = undefined;
    }
    await Promise.race([Promise.allSettled(sessions.map((s) => s.done)), delay(timeoutMs, undefined, { ref: false })]);
  }

  cancelTask = async (taskId: string, bus: ExecutionEventBus): Promise<void> => {
    const session = this.sessions.get(taskId);
    if (!session) {
      // Nothing running here; still publish a terminal event so the SDK's cancel call returns.
      this.publishStatus(bus, taskId, '', TaskState.TASK_STATE_CANCELED, 'Canceled.');
      return;
    }
    session.abort.abort(new AgentTaskError('CANCELED', 'Canceled by COS'));
    if (session.pending) {
      // Parked on a question: no run loop will publish for us, so publish CANCELED now.
      session.pending.reject(new AgentTaskError('CANCELED', 'Canceled while waiting for the user'));
      session.pending = undefined;
      session.finished = true;
      this.publishStatus(bus, taskId, session.contextId, TaskState.TASK_STATE_CANCELED, 'Canceled while waiting for input.');
    }
  };

  // ---------- internals ----------

  private async runTask(ctx: TaskRunContext, bus: ExecutionEventBus, span: SpanHandle, session: Session): Promise<void> {
    const ids = { taskId: ctx.taskId, contextId: ctx.contextId, traceId: span.traceId };
    this.telemetry.status('busy', ctx.instruction.slice(0, 160), ids);
    this.publishStatus(bus, ctx.taskId, ctx.contextId, TaskState.TASK_STATE_WORKING, 'Started.');
    const heartbeat = setInterval(() => {
      if (!session.pending && !session.finished) this.publishStatus(bus, ctx.taskId, ctx.contextId, TaskState.TASK_STATE_WORKING);
    }, HEARTBEAT_MS);
    try {
      const outcome = await this.run(ctx);
      if (ctx.signal.aborted) throw new AgentTaskError('CANCELED', 'Canceled by COS');
      bus.publish(
        AgentEvent.artifactUpdate({
          taskId: ctx.taskId,
          contextId: ctx.contextId,
          append: false,
          lastChunk: true,
          metadata: undefined,
          artifact: {
            artifactId: crypto.randomUUID(),
            name: outcome.artifactName,
            description: outcome.summary.slice(0, 200),
            parts: [dataPart(outcome.result)],
            metadata: undefined,
            extensions: [],
          },
        }),
      );
      session.finished = true;
      this.publishStatus(bus, ctx.taskId, ctx.contextId, TaskState.TASK_STATE_COMPLETED, outcome.summary);
      this.telemetry.emit(
        'a2a',
        { direction: 'send', to: 'cos', state: 'completed', text: outcome.summary, data: outcome.result },
        ids,
      );
      this.telemetry.status('idle', 'task completed', ids);
      span.end();
    } catch (err) {
      const payload = toErrorPayload(err, ctx.signal);
      const alreadyFinished = session.finished;
      session.finished = true;
      if (payload.code === 'CANCELED') {
        if (!alreadyFinished) this.publishStatus(bus, ctx.taskId, ctx.contextId, TaskState.TASK_STATE_CANCELED, payload.message);
        this.telemetry.status('idle', 'task canceled', ids);
      } else {
        if (!alreadyFinished) this.publishFailure(bus, ctx.taskId, ctx.contextId, payload);
        this.telemetry.error(err, { code: payload.code }, ids);
        this.telemetry.status('error', payload.message, ids);
      }
      const state = payload.code === 'CANCELED' ? 'canceled' : 'failed';
      this.telemetry.emit('a2a', { direction: 'send', to: 'cos', state, data: payload }, ids);
      span.end(payload.code === 'CANCELED' ? undefined : err);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private ask(
    bus: ExecutionEventBus,
    taskId: string,
    session: Session,
    question: string,
    options?: string[],
  ): Promise<string> {
    if (session.abort.signal.aborted) return Promise.reject(new AgentTaskError('CANCELED', 'Canceled by COS'));
    if (session.pending) return Promise.reject(new Error('A question is already pending for this task'));
    const ids = { taskId, contextId: session.contextId };
    return new Promise<string>((resolve, reject) => {
      session.pending = { resolve, reject };
      const payload: UserQuestion = { type: 'user-question', question, ...(options?.length ? { options } : {}) };
      // INPUT_REQUIRED must be a statusUpdate (a Task-only event never releases the client).
      this.publishStatus(bus, taskId, session.contextId, TaskState.TASK_STATE_INPUT_REQUIRED, question, [dataPart(payload)]);
      this.telemetry.emit('a2a', { direction: 'send', to: 'cos', state: 'input-required', text: question, data: payload }, ids);
      this.telemetry.status('waiting_input', question.slice(0, 160), ids);
    });
  }

  private publishStatus(
    bus: ExecutionEventBus,
    taskId: string,
    contextId: string,
    state: TaskState,
    text?: string,
    extraParts: Part[] = [],
  ): void {
    const parts = [...(text ? [textPart(text)] : []), ...extraParts];
    bus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId,
        metadata: {},
        status: {
          state,
          timestamp: now(),
          message: parts.length ? makeMessage(Role.ROLE_AGENT, parts, { taskId, contextId }) : undefined,
        },
      }),
    );
    if (state === TaskState.TASK_STATE_WORKING && text) {
      this.telemetry.emit('a2a', { direction: 'send', to: 'cos', state: stateName(state), text }, { taskId, contextId });
    }
  }

  private publishFailure(bus: ExecutionEventBus, taskId: string, contextId: string, payload: AgentErrorPayload): void {
    const text = payload.hint ? `${payload.message}\n${payload.hint}` : payload.message;
    this.publishStatus(bus, taskId, contextId, TaskState.TASK_STATE_FAILED, text, [dataPart(payload)]);
  }
}

function toErrorPayload(err: unknown, signal: AbortSignal): AgentErrorPayload {
  if (err instanceof AgentTaskError) {
    return { type: 'error', code: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}) };
  }
  if (signal.aborted) return { type: 'error', code: 'CANCELED', message: 'Canceled by COS' };
  return { type: 'error', code: 'INTERNAL', message: errorMessage(err) };
}
