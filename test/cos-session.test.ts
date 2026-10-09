import { afterAll, describe, expect, it } from 'vitest';
import { OrderState } from '../src/agents/cos/order-state.js';
import { detectLang, reply } from '../src/agents/cos/replies.js';
import { CosSession, isEndOfTurn, renderTurn } from '../src/agents/cos/session.js';
import { resetEnvCache } from '../src/config/env.js';
import { Telemetry } from '../src/observability/telemetry.js';

const savedKey = process.env.ANTHROPIC_API_KEY;

afterAll(() => {
  if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
  resetEnvCache();
});

describe('CosSession', () => {
  it('without an API key keeps running and answers every message with a setup error in the user language', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    resetEnvCache();
    const notified: string[] = [];
    let lang: 'uk' | 'en' = 'uk';
    const session = new CosSession({
      state: new OrderState('karashynyard'),
      telemetry: new Telemetry('cos'),
      makeToolServer: () => {
        throw new Error('no session may start without a key');
      },
      describeQuestions: () => '',
      whenToolsIdle: async () => {},
      lang: () => lang,
      notify: async (text) => void notified.push(text),
    });

    session.start();
    session.push('хочу замовити');
    lang = 'en';
    session.push('hello?');
    await new Promise((r) => setTimeout(r, 20));

    expect(notified).toHaveLength(2);
    expect(notified[0]).toMatch(/^Помилка налаштування: ANTHROPIC_API_KEY is not set\. .*\.env/);
    expect(notified[1]).toMatch(/^Setup error: ANTHROPIC_API_KEY is not set\./);
    expect(session.busy).toBe(false);
    await session.close();
  });
});

describe('renderTurn', () => {
  const at = new Date('2026-10-08T17:00:00.000Z');

  it('marks when each message arrived and whether it waited for an earlier turn, next to the order facts', () => {
    const turn = renderTurn(
      [
        { kind: 'telegram', text: '1 - 2', receivedAt: at, queued: false },
        { kind: 'telegram', text: 'і ще 5', receivedAt: new Date(at.getTime() + 1_000), queued: true },
        { kind: 'system', text: 'Continue the current order.', receivedAt: at, queued: false },
      ],
      '- taskId=t1 agent=explore relayed=yes',
      'Order o1',
    );
    expect(turn).toBe(
      [
        '<telegram_message received="2026-10-08T17:00:00.000Z">\n1 - 2\n</telegram_message>',
        '<telegram_message received="2026-10-08T17:00:01.000Z" queued="yes">\nі ще 5\n</telegram_message>',
        '<system_event received="2026-10-08T17:00:00.000Z">\nContinue the current order.\n</system_event>',
        '<pending_subagent_questions>\n- taskId=t1 agent=explore relayed=yes\n</pending_subagent_questions>',
        '<order_state>\nOrder o1\n</order_state>',
      ].join('\n\n'),
    );
  });
});

describe('isEndOfTurn', () => {
  it.each(['done', ' Done. ', 'DONE!', ''])('treats %j as the silent end of a turn', (text) => {
    expect(isEndOfTurn(text)).toBe(true);
  });

  it.each(['Done, the basket is ready', 'Готово', 'not done'])('forwards %j to the user', (text) => {
    expect(isEndOfTurn(text)).toBe(false);
  });
});

describe('replies', () => {
  it('follows the language the user writes in', () => {
    expect(detectLang('хочу замовити')).toBe('uk');
    expect(detectLang('I want to order')).toBe('en');
    expect(detectLang('1 - 2\n5')).toBeUndefined();
    expect(detectLang('Філе 2 kg')).toBe('uk');
  });

  it('renders every reply in both languages', () => {
    expect(reply('uk', 'busy', 'execute')).toMatch(/^Прийняв\..*execute/);
    expect(reply('en', 'busy', 'execute')).toMatch(/^Got it\..*current step finishes.*execute/);
    expect(reply('uk', 'stopped', 1)).toContain('Скасовано завдань: 1');
    expect(reply('en', 'stopped', 1)).toBe('Stopped. Canceled 1 running task(s). The order is kept: write to continue, or /new to start over.');
    expect(reply('uk', 'notFinished', 'error_during_execution')).toMatch(/^Вибачте/);
  });
});
