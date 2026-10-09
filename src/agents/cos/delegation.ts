/**
 * COS's A2A client side: one client per sub-agent; every exchange is streamed into a TaskSnapshot
 * the LLM can act on. A2A and network failures never throw out of send/answer: they come back as
 * `snapshot.error`, so the COS model can explain them and offer a retry.
 */
import { setTimeout as delay } from 'node:timers/promises';
import type { StreamResponse } from '@a2a-js/sdk';
import type { Client } from '@a2a-js/sdk/client';
import { A2AError, TaskNotCancelableError, TaskNotFoundError, UnsupportedOperationError } from '@a2a-js/sdk/errors';
import { subAgentSpec, type SubAgentName } from '../../config/agents.js';
import { env } from '../../config/env.js';
import { preview, SpanKind, type Telemetry } from '../../observability/telemetry.js';
import {
  artifactData,
  createA2AClient,
  dataOf,
  dataPart,
  makeMessage,
  Role,
  sendRequest,
  stateName,
  TaskState,
  textOf,
  textPart,
  type Part,
} from '../../shared/a2a.js';
import { AgentErrorPayload, pickPayload, UserQuestion, type ErrorCode } from '../../shared/contracts.js';
import { errorMessage } from '../../shared/logger.js';

export interface TaskSnapshot {
  agent: SubAgentName;
  taskId: string;
  contextId: string;
  /** A2A task state in kebab case: 'working', 'input-required', 'completed', 'failed', 'canceled', ... */
  state: string;
  /** Latest status text from the agent (progress note, question, summary or failure). */
  text: string;
  question?: string;
  options?: string[];
  /** First DataPart of the task's artifact (one of the contracts payloads). */
  result?: unknown;
  error?: AgentErrorPayload;
  updatedAt: Date;
}

export interface DelegateInput {
  instruction: string;
  payloads: unknown[];
  /** The order id: every task of one order shares the A2A contextId. */
  contextId: string;
}

const FINAL_STATES = new Set(['completed', 'failed', 'canceled', 'rejected']);
const CANCEL_TIMEOUT_MS = 10_000;
const POLL_MS = 2_000;
const MAX_TRACKED_TASKS = 200;

const isFinalState = (state: string): boolean => FINAL_STATES.has(state);

interface TrackedTask {
  snapshot: TaskSnapshot;
  /** traceparent of the span that created the task, so follow-ups join the same trace. */
  traceparent: string;
}

export class Delegator {
  private readonly clients = new Map<SubAgentName, Promise<Client>>();
  private readonly tasks = new Map<string, TrackedTask>();
  /** Open streams, so cancelAll can also release an exchange whose task id is not known yet. */
  private readonly open = new Set<AbortController>();

  constructor(
    private readonly telemetry: Telemetry,
    private readonly baseUrlOf: (agent: SubAgentName) => string = (agent) => subAgentSpec(agent).baseUrl,
  ) {}

  /** Start a new task on `agent` and wait until it completes, fails or asks a question. */
  send(agent: SubAgentName, input: DelegateInput): Promise<TaskSnapshot> {
    const snapshot: TaskSnapshot = { agent, taskId: '', contextId: input.contextId, state: 'submitted', text: '', updatedAt: new Date() };
    const parts = [textPart(input.instruction), ...input.payloads.map(dataPart)];
    return this.exchange(snapshot, 'send', parts);
  }

  /** Answer the pending question of `taskId` (same task and context) and wait for the next stop. */
  async answer(taskId: string, text: string): Promise<TaskSnapshot> {
    const tracked = this.tracked(taskId);
    if (tracked.snapshot.state !== 'input-required') {
      throw new Error(`Task ${taskId} (${tracked.snapshot.agent}) is ${tracked.snapshot.state}, not waiting for an answer.`);
    }
    Object.assign(tracked.snapshot, { state: 'working', question: undefined, options: undefined, error: undefined });
    return this.exchange(tracked.snapshot, 'answer', [textPart(text)], tracked.traceparent);
  }

  async cancel(taskId: string): Promise<TaskSnapshot> {
    const { snapshot } = this.tracked(taskId);
    if (isFinalState(snapshot.state)) return { ...snapshot };
    try {
      const client = await this.client(snapshot.agent);
      const task = await client.cancelTask(
        { tenant: '', id: taskId, metadata: {} },
        { signal: AbortSignal.timeout(CANCEL_TIMEOUT_MS) },
      );
      this.applyStatus(snapshot, task.status?.state, task.status?.message?.parts);
    } catch (err) {
      // Not cancelable = it just finished; the open stream (if any) reports the real outcome.
      if (!(err instanceof TaskNotCancelableError)) {
        // The agent lost the task or is unreachable: either way it will never continue.
        snapshot.state = 'canceled';
        snapshot.error = this.toErrorPayload(snapshot.agent, err);
      }
    }
    snapshot.updatedAt = new Date();
    this.emitReceive(snapshot, 'cancel');
    return { ...snapshot };
  }

  /** Cancel every task that is still running or waiting for the user. Returns how many. */
  async cancelAll(): Promise<number> {
    const active = this.activeTasks();
    await Promise.allSettled(active.map((t) => this.cancel(t.taskId)));
    for (const controller of this.open) controller.abort();
    return active.length;
  }

  get(taskId: string): TaskSnapshot | undefined {
    const tracked = this.tasks.get(taskId);
    return tracked ? { ...tracked.snapshot } : undefined;
  }

  /** Tasks that are running or waiting for an answer. */
  activeTasks(): TaskSnapshot[] {
    return [...this.tasks.values()].filter((t) => !isFinalState(t.snapshot.state)).map((t) => ({ ...t.snapshot }));
  }

  // ---------- internals ----------

  private async exchange(snapshot: TaskSnapshot, kind: 'send' | 'answer', parts: Part[], parent?: string): Promise<TaskSnapshot> {
    const { agent } = snapshot;
    const span = this.telemetry.startSpan(
      `a2a.send ${agent}`,
      { 'a2a.agent': agent, 'a2a.kind': kind, 'a2a.context_id': snapshot.contextId, 'a2a.task_id': snapshot.taskId },
      parent,
      SpanKind.CLIENT,
    );
    const message = makeMessage(Role.ROLE_USER, parts, {
      ...(snapshot.taskId ? { taskId: snapshot.taskId } : {}),
      contextId: snapshot.contextId,
      metadata: { traceparent: span.traceparent },
    });
    this.telemetry.emit(
      'a2a',
      { direction: 'send', to: agent, kind, text: preview(textOf(parts), 1_000), data: dataOf(parts) },
      { taskId: snapshot.taskId || undefined, contextId: snapshot.contextId, traceId: span.traceId },
    );

    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(env().SUBAGENT_TIMEOUT_MS)]);
    this.open.add(abort);
    try {
      const client = await this.client(agent);
      try {
        for await (const event of client.sendMessageStream(sendRequest(message), { signal })) {
          this.apply(snapshot, event, span.traceparent);
        }
      } catch (err) {
        if (!snapshot.taskId || signal.aborted || err instanceof A2AError) throw err;
        // The stream broke while the task runs on (e.g. fetch's 5-minute body timeout during a long
        // silent browser run). The agent's task store keeps recording, so follow the task from there.
        this.telemetry.emit(
          'log',
          { level: 'warn', text: `A2A stream to ${agent} broke (${errorMessage(err)}); polling the task` },
          { taskId: snapshot.taskId, contextId: snapshot.contextId },
        );
        await this.poll(client, snapshot, signal);
      }
      if (!isFinalState(snapshot.state) && snapshot.state !== 'input-required') {
        snapshot.error = {
          type: 'error',
          code: 'INTERNAL',
          message: `The ${agent} agent closed the connection while the task was ${snapshot.state}.`,
        };
      }
    } catch (err) {
      this.applyFailure(snapshot, err, abort.signal, signal);
    } finally {
      this.open.delete(abort);
      span.end(snapshot.error && snapshot.state !== 'canceled' ? new Error(snapshot.error.message) : undefined, {
        'a2a.task_id': snapshot.taskId,
        'a2a.state': snapshot.state,
      });
    }
    return { ...snapshot };
  }

  /** Follow a task through getTask until it finishes or asks a question. */
  private async poll(client: Client, snapshot: TaskSnapshot, signal: AbortSignal): Promise<void> {
    while (!isFinalState(snapshot.state) && snapshot.state !== 'input-required') {
      await delay(POLL_MS, undefined, { signal });
      const task = await client.getTask({ tenant: '', id: snapshot.taskId }, { signal });
      const before = snapshot.state;
      this.applyStatus(snapshot, task.status?.state, task.status?.message?.parts);
      const result = artifactData(task)[0];
      if (result !== undefined) snapshot.result = result;
      if (snapshot.state !== before) {
        snapshot.updatedAt = new Date();
        this.emitReceive(snapshot, 'poll');
      }
    }
  }

  private apply(snapshot: TaskSnapshot, event: StreamResponse, traceparent: string): void {
    const payload = event.payload;
    switch (payload?.$case) {
      case 'task': {
        const task = payload.value;
        // A follow-up turn starts with the stored task (still showing the answered question): skip its status.
        const isNew = !snapshot.taskId;
        this.track(snapshot, task.id, task.contextId, traceparent);
        if (isNew) this.applyStatus(snapshot, task.status?.state, task.status?.message?.parts);
        const result = artifactData(task)[0];
        if (result !== undefined) snapshot.result = result;
        break;
      }
      case 'statusUpdate':
        this.track(snapshot, payload.value.taskId, payload.value.contextId, traceparent);
        this.applyStatus(snapshot, payload.value.status?.state, payload.value.status?.message?.parts);
        break;
      case 'artifactUpdate': {
        const result = dataOf(payload.value.artifact?.parts)[0];
        if (result !== undefined && snapshot.result === undefined) snapshot.result = result;
        break;
      }
      case 'message': {
        const text = textOf(payload.value.parts);
        if (text) snapshot.text = text;
        break;
      }
      default:
        return;
    }
    snapshot.updatedAt = new Date();
    this.emitReceive(snapshot, payload.$case);
  }

  private applyStatus(snapshot: TaskSnapshot, state: TaskState | undefined, parts: readonly Part[] | undefined): void {
    if (state === undefined) return;
    snapshot.state = stateName(state);
    const text = textOf(parts);
    if (text) snapshot.text = text;
    const data = dataOf(parts);
    if (state === TaskState.TASK_STATE_INPUT_REQUIRED) {
      const question = pickPayload(data, UserQuestion);
      snapshot.question = question?.question ?? text;
      snapshot.options = question?.options;
    } else {
      snapshot.question = undefined;
      snapshot.options = undefined;
    }
    if (state === TaskState.TASK_STATE_FAILED) {
      // The SDK reports an executor crash as FAILED with only a text part.
      snapshot.error = pickPayload(data, AgentErrorPayload) ?? { type: 'error', code: 'INTERNAL', message: text || 'The task failed.' };
    }
  }

  private applyFailure(snapshot: TaskSnapshot, err: unknown, ours: AbortSignal, combined: AbortSignal): void {
    snapshot.updatedAt = new Date();
    if (ours.aborted) {
      snapshot.state = 'canceled';
      snapshot.error = { type: 'error', code: 'CANCELED', message: 'Canceled by COS.' };
    } else if (combined.aborted) {
      snapshot.state = 'failed';
      const minutes = Math.round(env().SUBAGENT_TIMEOUT_MS / 60_000);
      snapshot.error = { type: 'error', code: 'INTERNAL', message: `No result from the ${snapshot.agent} agent within ${minutes} min; the task was canceled.` };
      if (snapshot.taskId) void this.cancelQuietly(snapshot);
    } else {
      snapshot.state = 'failed';
      snapshot.error = this.toErrorPayload(snapshot.agent, err);
    }
    this.emitReceive(snapshot, 'error');
  }

  private toErrorPayload(agent: SubAgentName, err: unknown): AgentErrorPayload {
    const error = (code: ErrorCode, message: string, hint?: string): AgentErrorPayload => ({
      type: 'error',
      code,
      message,
      ...(hint ? { hint } : {}),
    });
    if (err instanceof TaskNotFoundError) {
      return error('SESSION_LOST', `The ${agent} agent no longer has this task (it was probably restarted).`, 'Start a new task for this step.');
    }
    if (err instanceof UnsupportedOperationError) {
      return error('INVALID_REQUEST', `The ${agent} task is already finished and cannot take more input.`, 'Start a new task for this step.');
    }
    // Not an A2A protocol error: most likely the agent process is down. Recreate the client next time.
    this.clients.delete(agent);
    return error('INTERNAL', `Cannot reach the ${agent} agent: ${errorMessage(err)}`, 'Retry the step; COS restarts the agent if it stopped.');
  }

  private async cancelQuietly(snapshot: TaskSnapshot): Promise<void> {
    try {
      const client = await this.client(snapshot.agent);
      await client.cancelTask({ tenant: '', id: snapshot.taskId, metadata: {} }, { signal: AbortSignal.timeout(CANCEL_TIMEOUT_MS) });
    } catch {
      // Best effort: the agent may already be gone.
    }
  }

  private track(snapshot: TaskSnapshot, taskId: string, contextId: string, traceparent: string): void {
    if (!taskId || snapshot.taskId === taskId) return;
    snapshot.taskId = taskId;
    if (contextId) snapshot.contextId = contextId;
    this.tasks.set(taskId, { snapshot, traceparent });
    if (this.tasks.size > MAX_TRACKED_TASKS) {
      const oldestFinal = [...this.tasks.entries()].find(([, t]) => isFinalState(t.snapshot.state));
      if (oldestFinal) this.tasks.delete(oldestFinal[0]);
    }
  }

  private tracked(taskId: string): TrackedTask {
    const tracked = this.tasks.get(taskId);
    if (!tracked) throw new Error(`Unknown task id "${taskId}".`);
    return tracked;
  }

  private client(agent: SubAgentName): Promise<Client> {
    let client = this.clients.get(agent);
    if (!client) {
      client = createA2AClient(this.baseUrlOf(agent));
      this.clients.set(agent, client);
      client.catch(() => this.clients.delete(agent));
    }
    return client;
  }

  private emitReceive(snapshot: TaskSnapshot, event: string): void {
    this.telemetry.emit(
      'a2a',
      {
        direction: 'receive',
        from: snapshot.agent,
        event,
        state: snapshot.state,
        text: preview(snapshot.text, 1_000),
        ...(snapshot.result !== undefined ? { data: preview(snapshot.result, 2_000) } : {}),
        ...(snapshot.error ? { error: snapshot.error } : {}),
      },
      { taskId: snapshot.taskId || undefined, contextId: snapshot.contextId },
    );
  }
}
