/**
 * CosSession's session loop with the Agent SDK's query() replaced by a scripted fake: when a session is replaced,
 * how a step cut by the budget is continued, and which plain-text endings reach the user.
 */
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OrderState } from '../src/agents/cos/order-state.js';
import { resetEnvCache } from '../src/config/env.js';
import { Telemetry } from '../src/observability/telemetry.js';

interface Turn {
  subtype?: 'success' | 'error_max_budget_usd' | 'error_max_turns';
  costUsd?: number;
  text?: string;
}

/** Each session's received turns; `respond` scripts the reply to the next one. */
const sessions: string[][] = [];
let respond: (session: number, content: string) => Turn = () => ({});

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  return {
    ...actual,
    query: ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
      const index = sessions.push([]) - 1;
      async function* run(): AsyncGenerator<SDKMessage> {
        for await (const user of prompt) {
          const content = String(user.message.content);
          sessions[index]!.push(content);
          const turn = respond(index, content);
          const subtype = turn.subtype ?? 'success';
          yield {
            type: 'result',
            subtype,
            is_error: subtype !== 'success',
            session_id: `s${index}`,
            num_turns: 1,
            duration_ms: 1,
            total_cost_usd: turn.costUsd ?? 0.01,
            modelUsage: {},
            permission_denials: [],
            ...(subtype === 'success' ? { result: turn.text ?? 'done' } : { errors: [subtype] }),
          } as unknown as SDKMessage;
        }
      }
      return Object.assign(run(), { close: () => {}, interrupt: async () => {} });
    },
  };
});

const { CosSession } = await import('../src/agents/cos/session.js');

const savedKey = process.env.ANTHROPIC_API_KEY;
beforeAll(() => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  resetEnvCache();
});
afterAll(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
  resetEnvCache();
});

function start(whenToolsIdle: () => Promise<void> = async () => {}) {
  sessions.length = 0;
  const notified: string[] = [];
  const session = new CosSession({
    state: new OrderState('karashynyard'),
    telemetry: new Telemetry('cos'),
    makeToolServer: () => ({}) as never,
    describeQuestions: () => 'No sub-agent question is waiting for the user.',
    whenToolsIdle,
    lang: () => 'uk',
    notify: async (text) => void notified.push(text),
  });
  session.start();
  return { session, notified };
}

describe('CosSession loop', () => {
  it('replaces the session between turns once it has spent 60% of its budget, without a word to the user', async () => {
    respond = (session) => ({ costUsd: session === 0 ? 1.3 : 0.1 }); // COS_MAX_BUDGET_USD defaults to 2
    const { session, notified } = start();
    session.push('хочу замовити');
    await vi.waitFor(() => expect(sessions).toHaveLength(2));
    session.push('1 - 2');
    await vi.waitFor(() => expect(sessions[1]).toHaveLength(1));
    expect(sessions[0]).toHaveLength(1);
    expect(sessions[1]![0]).toContain('1 - 2');
    expect(notified).toEqual([]);
    await session.close();
  });

  it('continues a step cut by the budget in a fresh session once running delegations are done, instead of "try again"', async () => {
    let releaseTools: () => void = () => {};
    const toolsIdle = new Promise<void>((resolve) => (releaseTools = resolve));
    respond = (session) => (session === 0 ? { subtype: 'error_max_budget_usd' } : {});
    const { session, notified } = start(() => toolsIdle);
    session.push('1 - 2');
    await vi.waitFor(() => expect(session.busy).toBe(true));
    // A message while the cut step waits is queued for the fresh session.
    session.push('і ще 5');
    await new Promise((r) => setTimeout(r, 50));
    expect(sessions).toHaveLength(1);

    releaseTools();
    await vi.waitFor(() => expect(sessions[1]?.length).toBeGreaterThan(0), { timeout: 5_000 });
    const resumed = sessions[1]!.join('\n');
    expect(resumed).toMatch(/<telegram_message received="[^"]+" queued="yes">\nі ще 5\n<\/telegram_message>/);
    expect(resumed).toMatch(/<system_event received="[^"]+">\nThe previous session stopped in the middle of a step/);
    expect(notified).toEqual([]);
    await session.close();
  }, 15_000);

  it('drops a cut step that waits to be continued when the user sends /stop', async () => {
    let releaseTools: () => void = () => {};
    const toolsIdle = new Promise<void>((resolve) => (releaseTools = resolve));
    respond = (session) => (session === 0 ? { subtype: 'error_max_turns' } : {});
    const { session, notified } = start(() => toolsIdle);
    session.push('1 - 2');
    await vi.waitFor(() => expect(session.busy).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    await session.interrupt(); // /stop: cancels the delegations (tools go idle) and drops the step
    releaseTools();
    await new Promise((r) => setTimeout(r, 2_500)); // past the restart back-off
    session.push('як там?');
    await vi.waitFor(() => expect(sessions[1]?.length).toBe(1), { timeout: 5_000 });
    expect(sessions[1]![0]).not.toContain('<system_event');
    expect(notified).toEqual([]);
    await session.close();
  }, 15_000);

  it('never shows the end-of-turn marker, but delivers other plain text the model wrote', async () => {
    respond = (_session, content) => ({ text: content.includes('привіт') ? 'Привіт! Напишіть «хочу замовити».' : 'done' });
    const { session, notified } = start();
    session.push('хочу замовити');
    await vi.waitFor(() => expect(sessions[0]).toHaveLength(1));
    session.push('привіт');
    await vi.waitFor(() => expect(notified).toEqual(['Привіт! Напишіть «хочу замовити».']));
    await session.close();
  });
});
