import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { splitMessage, TELEGRAM_MAX_CHARS, TelegramGateway, type GatewayCommand } from '../src/agents/cos/telegram.js';
import { Telemetry } from '../src/observability/telemetry.js';

const TOKEN = '123:TEST';
const OWNER = 111;
const STRANGER = 222;

interface ApiCall {
  method: string;
  body: Record<string, unknown>;
}

/** Minimal Telegram Bot API: queued updates for getUpdates, every call recorded. */
class FakeBotApi {
  readonly calls: ApiCall[] = [];
  private readonly updates: unknown[] = [];
  private nextUpdateId = 1;
  private server: Server | undefined;

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
      req.on('end', () => {
        const method = (req.url ?? '').split('/').pop() ?? '';
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        this.calls.push({ method, body });
        void this.result(method, body).then((result) => {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok: true, result }));
        });
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  pushText(fromId: number, text: string): void {
    const command = text.match(/^\/\w+/)?.[0];
    this.updates.push({
      update_id: this.nextUpdateId++,
      message: {
        message_id: this.nextUpdateId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: fromId, type: 'private', first_name: 'U' },
        from: { id: fromId, is_bot: false, first_name: 'U' },
        text,
        ...(command ? { entities: [{ type: 'bot_command', offset: 0, length: command.length }] } : {}),
      },
    });
  }

  pushPhoto(fromId: number): void {
    this.updates.push({
      update_id: this.nextUpdateId++,
      message: {
        message_id: this.nextUpdateId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: fromId, type: 'private', first_name: 'U' },
        from: { id: fromId, is_bot: false, first_name: 'U' },
        photo: [{ file_id: 'f', file_unique_id: 'u', width: 1, height: 1 }],
      },
    });
  }

  sent(): Array<{ chatId: unknown; text: string }> {
    return this.calls.filter((c) => c.method === 'sendMessage').map((c) => ({ chatId: c.body.chat_id, text: String(c.body.text) }));
  }

  private async result(method: string, body: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'getMe':
        return { id: 999, is_bot: true, first_name: 'Test', username: 'test_bot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false };
      case 'getUpdates': {
        const offset = typeof body.offset === 'number' ? body.offset : 0;
        const pending = () => this.updates.filter((u) => (u as { update_id: number }).update_id >= offset);
        if (pending().length === 0) await new Promise((r) => setTimeout(r, 30));
        return pending();
      }
      case 'sendMessage':
        return { message_id: this.calls.length, date: Math.floor(Date.now() / 1000), chat: { id: body.chat_id, type: 'private' }, text: body.text };
      default:
        return true;
    }
  }
}

async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const telemetry = new Telemetry('cos');
let api: FakeBotApi;
let gateway: TelegramGateway | undefined;

async function startGateway(
  allowedUserId: number | undefined,
  handlers: { onMessage?: (text: string) => void; onCommand?: (c: GatewayCommand) => string | Promise<string> } = {},
): Promise<TelegramGateway> {
  api = new FakeBotApi();
  const apiRoot = await api.start();
  gateway = new TelegramGateway({
    token: TOKEN,
    allowedUserId,
    apiRoot,
    shopName: 'karashynyard.com.ua',
    telemetry,
    onMessage: handlers.onMessage ?? (() => {}),
    onCommand: handlers.onCommand ?? ((c) => `ok ${c}`),
  });
  await gateway.start();
  return gateway;
}

afterEach(async () => {
  await gateway?.stop();
  gateway = undefined;
  await api?.stop();
});

describe('TelegramGateway', () => {
  it('serves only the allowed user', async () => {
    const received: string[] = [];
    await startGateway(OWNER, { onMessage: (t) => received.push(t) });
    expect(api.calls.find((c) => c.method === 'deleteWebhook')?.body).toMatchObject({ drop_pending_updates: true });

    api.pushText(STRANGER, 'hello from a stranger');
    api.pushText(STRANGER, '/status');
    api.pushText(OWNER, 'хочу замовити');
    await waitFor(() => received.length === 1);
    await new Promise((r) => setTimeout(r, 100));

    expect(received).toEqual(['хочу замовити']);
    expect(api.sent().filter((m) => m.chatId === STRANGER)).toEqual([]);
  });

  it('setup mode: answers /start with the user id and ignores everything else', async () => {
    const received: string[] = [];
    await startGateway(undefined, { onMessage: (t) => received.push(t) });

    api.pushText(STRANGER, 'hi');
    api.pushText(STRANGER, '/start');
    await waitFor(() => api.sent().length === 1);
    await new Promise((r) => setTimeout(r, 100));

    const [reply] = api.sent();
    expect(reply?.chatId).toBe(STRANGER);
    expect(reply?.text).toContain(`TELEGRAM_ALLOWED_USER_ID=${STRANGER}`);
    expect(api.sent()).toHaveLength(1);
    expect(received).toEqual([]);
    await expect(gateway!.send('anything')).rejects.toThrow(/setup mode/);
  });

  it('splits long messages on line boundaries and sends plain text to the owner', async () => {
    await startGateway(OWNER);
    const lines = Array.from({ length: 300 }, (_, i) => `${i + 1}. Філе зі стегна індички, 1 кг — 665 грн`);
    const text = lines.join('\n');
    await gateway!.send(text);

    const sent = api.sent();
    expect(sent.length).toBeGreaterThan(1);
    for (const m of sent) {
      expect(m.chatId).toBe(OWNER);
      expect(m.text.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS);
    }
    expect(sent.map((m) => m.text).join('\n')).toBe(text);
    expect(api.calls.filter((c) => c.method === 'sendMessage').every((c) => c.body.parse_mode === undefined)).toBe(true);
  });

  it('does not block later updates while a command is still running', async () => {
    let releaseStop: (text: string) => void = () => {};
    await startGateway(OWNER, {
      onCommand: (c) => (c === 'stop' ? new Promise<string>((resolve) => (releaseStop = resolve)) : `status: idle`),
    });

    api.pushText(OWNER, '/stop');
    await new Promise((r) => setTimeout(r, 100));
    api.pushText(OWNER, '/status');
    await waitFor(() => api.sent().some((m) => m.text === 'status: idle'));
    expect(api.sent().some((m) => m.text === 'stopped')).toBe(false);

    releaseStop('stopped');
    await waitFor(() => api.sent().some((m) => m.text === 'stopped'));
  });

  it('puts every message of the user into the transcript once, commands and photos included', async () => {
    const emit = vi.spyOn(telemetry, 'emit');
    try {
      await startGateway(OWNER);
      api.pushText(OWNER, '/help');
      api.pushText(OWNER, '/status');
      api.pushPhoto(OWNER);
      api.pushText(OWNER, 'хочу замовити');
      const incoming = () => emit.mock.calls.filter(([kind, data]) => kind === 'telegram' && data.direction === 'in').map(([, data]) => data.text);
      await waitFor(() => incoming().length >= 4 && api.sent().length === 3);
      expect(incoming()).toEqual(['/help', '/status', '[photo]', 'хочу замовити']);
    } finally {
      emit.mockRestore();
    }
  });

  it('answers /help with examples including "save info"', async () => {
    await startGateway(OWNER);
    api.pushText(OWNER, '/help');
    await waitFor(() => api.sent().length === 1);
    expect(api.sent()[0]?.text).toContain('save info - add');
  });
});

describe('splitMessage', () => {
  it('keeps short text as one message and hard-wraps an over-long line', () => {
    expect(splitMessage('a\nb')).toEqual(['a\nb']);
    const long = 'x'.repeat(TELEGRAM_MAX_CHARS * 2 + 10);
    const parts = splitMessage(long);
    expect(parts.map((p) => p.length)).toEqual([TELEGRAM_MAX_CHARS, TELEGRAM_MAX_CHARS, 10]);
    expect(parts.join('')).toBe(long);
  });

  it('never cuts an emoji in half', () => {
    const text = `${'x'.repeat(9)}😀tail`;
    const parts = splitMessage(text, 10);
    expect(parts[0]).toBe('x'.repeat(9));
    expect(parts.join('')).toBe(text);
  });
});
