import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Delegator } from '../src/agents/cos/delegation.js';
import { resetEnvCache } from '../src/config/env.js';
import { Telemetry } from '../src/observability/telemetry.js';
import { buildAgentCard, startA2AServer, type A2AServerHandle } from '../src/shared/a2a.js';
import type { Selection } from '../src/shared/contracts.js';
import { AgentTaskError, LongLivedExecutor, type TaskOutcome, type TaskRunContext } from '../src/shared/task-executor.js';

/** Stub Explore: asks one question, then completes with a Selection built from the answer. */
class StubExplore extends LongLivedExecutor {
  readonly traceparents: unknown[] = [];
  readonly runTraceIds: string[] = [];

  override async execute(rc: RequestContext, bus: ExecutionEventBus): Promise<void> {
    this.traceparents.push(rc.userMessage.metadata?.traceparent);
    return super.execute(rc, bus);
  }

  protected async run(ctx: TaskRunContext): Promise<TaskOutcome> {
    this.runTraceIds.push(ctx.span.traceId);
    if (ctx.instruction.includes('slow')) {
      if (ctx.instruction.includes('ask first')) await ctx.ask('Go?');
      await new Promise((r) => setTimeout(r, 800));
      return { summary: 'Slow work done', result: { type: 'slow-result' }, artifactName: 'slow' };
    }
    if (ctx.instruction.includes('no browser')) {
      throw new AgentTaskError('BROWSER_NOT_CONNECTED', 'Cannot reach the browser', 'Install the Playwright MCP Bridge extension, then retry.');
    }
    const answer = await ctx.ask('Що замовити?\n1. Філе\n2. Стегно', ['1 - 2', '2']);
    const result: Selection = { type: 'selection', shopId: 'karashynyard', items: [{ name: answer, qty: 2 }] };
    return { summary: `Selected ${answer} × 2`, result, artifactName: 'selection' };
  }
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

const request = { type: 'explore-request', action: 'select-products', shopId: 'karashynyard' };
let server: A2AServerHandle;
let stub: StubExplore;
let telemetry: Telemetry;
let delegator: Delegator;

beforeAll(async () => {
  // Real (exporting nowhere) spans, so traceparents carry real ids.
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:9';
  resetEnvCache();
  telemetry = new Telemetry('cos');
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  stub = new StubExplore('explore', new Telemetry('explore'));
  server = await startA2AServer({
    card: buildAgentCard({ name: 'Stub explore', description: 'test', baseUrl, skills: [] }),
    executor: stub,
    host: '127.0.0.1',
    port,
  });
  delegator = new Delegator(telemetry, () => baseUrl);
});

afterAll(async () => {
  await server?.close();
});

describe('Delegator', () => {
  it('relays a question, answers it on the same task and gets the result artifact', async () => {
    const contextId = crypto.randomUUID();
    const asked = await delegator.send('explore', { instruction: 'Ask what to buy', payloads: [request], contextId });
    expect(asked).toMatchObject({ agent: 'explore', state: 'input-required', contextId, question: 'Що замовити?\n1. Філе\n2. Стегно', options: ['1 - 2', '2'] });
    expect(asked.taskId).not.toBe('');
    expect(delegator.activeTasks().map((t) => t.taskId)).toContain(asked.taskId);

    const done = await delegator.answer(asked.taskId, 'Філе');
    expect(done).toMatchObject({ taskId: asked.taskId, contextId, state: 'completed', text: 'Selected Філе × 2' });
    expect(done.question).toBeUndefined();
    expect(done.result).toEqual({ type: 'selection', shopId: 'karashynyard', items: [{ name: 'Філе', qty: 2 }] });
    expect(delegator.activeTasks().map((t) => t.taskId)).not.toContain(asked.taskId);

    await expect(delegator.answer(asked.taskId, 'again')).rejects.toThrow(/not waiting for an answer/);
  });

  it('forwards the traceparent in message metadata and the sub-agent span joins that trace', async () => {
    const before = stub.traceparents.length;
    await delegator.send('explore', { instruction: 'Ask what to buy', payloads: [request], contextId: crypto.randomUUID() });
    const traceparent = stub.traceparents[before];
    expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
    const traceId = String(traceparent).split('-')[1];
    expect(traceId).not.toBe('0'.repeat(32));
    expect(stub.runTraceIds.at(-1)).toBe(traceId);
  });

  it('cancels a task parked on a question', async () => {
    const asked = await delegator.send('explore', { instruction: 'Ask what to buy', payloads: [request], contextId: crypto.randomUUID() });
    expect(asked.state).toBe('input-required');
    const canceled = await delegator.cancel(asked.taskId);
    expect(canceled.state).toBe('canceled');
    expect(delegator.get(asked.taskId)?.state).toBe('canceled');
    expect(delegator.activeTasks().map((t) => t.taskId)).not.toContain(asked.taskId);
  });

  it('cancelAll cancels every waiting task', async () => {
    const a = await delegator.send('explore', { instruction: 'Ask', payloads: [request], contextId: crypto.randomUUID() });
    const b = await delegator.send('explore', { instruction: 'Ask', payloads: [request], contextId: crypto.randomUUID() });
    expect(await delegator.cancelAll()).toBeGreaterThanOrEqual(2);
    expect(delegator.get(a.taskId)?.state).toBe('canceled');
    expect(delegator.get(b.taskId)?.state).toBe('canceled');
    expect(delegator.activeTasks()).toEqual([]);
  });

  it('returns a failed task with the structured error payload', async () => {
    const failed = await delegator.send('explore', { instruction: 'no browser', payloads: [request], contextId: crypto.randomUUID() });
    expect(failed.state).toBe('failed');
    expect(failed.error).toEqual({
      type: 'error',
      code: 'BROWSER_NOT_CONNECTED',
      message: 'Cannot reach the browser',
      hint: 'Install the Playwright MCP Bridge extension, then retry.',
    });
  });

  it('follows the task through getTask when the stream breaks mid-task', async () => {
    const emit = vi.spyOn(telemetry, 'emit');
    const pending = delegator.send('explore', { instruction: 'slow', payloads: [request], contextId: crypto.randomUUID() });
    await new Promise((r) => setTimeout(r, 300));
    server.server.closeAllConnections(); // e.g. fetch's body timeout during a long silent run
    const done = await pending;
    expect(done).toMatchObject({ state: 'completed', text: 'Slow work done', result: { type: 'slow-result' } });
    expect(done.error).toBeUndefined();
    expect(emit.mock.calls.some(([kind, data]) => kind === 'log' && String(data.text).includes('polling the task'))).toBe(true);
    emit.mockRestore();
  });

  it('does not report the answered question again when the stream breaks after an answer', async () => {
    const asked = await delegator.send('explore', { instruction: 'slow, ask first', payloads: [request], contextId: crypto.randomUUID() });
    expect(asked.state).toBe('input-required');
    const pending = delegator.answer(asked.taskId, 'yes');
    await new Promise((r) => setTimeout(r, 300));
    server.server.closeAllConnections();
    const done = await pending;
    expect(done).toMatchObject({ state: 'completed', result: { type: 'slow-result' } });
    expect(done.question).toBeUndefined();
  });

  it('turns an unreachable agent into an error snapshot instead of throwing', async () => {
    const port = await freePort();
    const offline = new Delegator(telemetry, () => `http://127.0.0.1:${port}`);
    const snapshot = await offline.send('qa', { instruction: 'verify', payloads: [], contextId: crypto.randomUUID() });
    expect(snapshot.state).toBe('failed');
    expect(snapshot.error?.code).toBe('INTERNAL');
    expect(snapshot.error?.message).toMatch(/Cannot reach the qa agent/);
  });
});
