/**
 * Fake Telegram Bot API for the COS gateway (grammY long polling): getMe, deleteWebhook, getUpdates
 * (real long polling with offset/timeout), setMyCommands, sendMessage. Keeps the chat transcript.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

export interface ChatLine {
  dir: 'user' | 'bot';
  text: string;
  at: string;
}

interface Update {
  update_id: number;
  message: Record<string, unknown>;
}

export interface FakeTelegram {
  url: string;
  token: string;
  userId: number;
  transcript: ChatLine[];
  /** Bot API methods called, in order (without bodies). */
  methods: string[];
  /** Requests that used another token or chat (must stay empty). */
  violations: string[];
  /** Resolves once the bot has started long polling (first getUpdates after the webhook was dropped). */
  polling(): Promise<void>;
  /** Resolves on the next getUpdates call, e.g. once a restarted gateway polls again. */
  nextPoll(): Promise<void>;
  sendUser(text: string): void;
  /** Wait for a bot message after transcript index `from` that satisfies `pred`; returns it and its index. */
  waitForBot(
    pred: (text: string) => boolean,
    opts: { from: number; timeoutMs: number; label: string; abortIf?: () => string | undefined },
  ): Promise<{ text: string; index: number }>;
  botMessages(from?: number): string[];
  reset(): void;
  close(): Promise<void>;
}

const BOT_USER = {
  id: 7_000_000_001,
  is_bot: true,
  first_name: 'POO e2e bot',
  username: 'poo_e2e_bot',
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
};

export async function startFakeTelegram(opts: { token: string; userId: number }): Promise<FakeTelegram> {
  const transcript: ChatLine[] = [];
  const methods: string[] = [];
  const violations: string[] = [];
  let updates: Update[] = [];
  let nextUpdateId = 1;
  let nextMessageId = 1;
  let waiters: Array<() => void> = [];
  let pollingStarted = false;
  let onPolling: Array<() => void> = [];

  const wake = () => {
    const w = waiters;
    waiters = [];
    for (const fn of w) fn();
  };

  const reply = (res: http.ServerResponse, result: unknown) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result }));
  };
  const fail = (res: http.ServerResponse, code: number, description: string) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error_code: code, description }));
  };

  const server = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', async () => {
      const match = (req.url ?? '').match(/^\/bot([^/]+)\/(\w+)/);
      if (!match) return fail(res, 404, 'Not Found');
      const [, token, method] = match as unknown as [string, string, string];
      if (token !== opts.token) {
        violations.push(`wrong token on ${method}`);
        return fail(res, 401, 'Unauthorized');
      }
      let body: Record<string, unknown> = {};
      const raw = Buffer.concat(parts).toString('utf8');
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        body = {};
      }
      methods.push(method);
      switch (method) {
        case 'getMe':
          return reply(res, BOT_USER);
        case 'deleteWebhook':
          if (body.drop_pending_updates) updates = [];
          return reply(res, true);
        case 'setMyCommands':
          return reply(res, true);
        case 'getUpdates': {
          if (!pollingStarted) {
            pollingStarted = true;
            for (const fn of onPolling) fn();
            onPolling = [];
          }
          const offset = typeof body.offset === 'number' ? body.offset : 0;
          updates = updates.filter((u) => u.update_id >= offset); // confirmed updates are gone
          const timeoutS = Math.min(typeof body.timeout === 'number' ? body.timeout : 0, 30);
          const deadline = Date.now() + timeoutS * 1000;
          let closed = false;
          res.once('close', () => (closed = true));
          while (updates.length === 0 && Date.now() < deadline && !closed) {
            await Promise.race([
              new Promise<void>((r) => waiters.push(r)),
              sleep(Math.max(0, deadline - Date.now()), undefined, { ref: false }),
            ]);
          }
          if (closed) return;
          const limit = typeof body.limit === 'number' && body.limit > 0 ? body.limit : 100;
          return reply(res, updates.slice(0, limit));
        }
        case 'sendMessage': {
          if (String(body.chat_id) !== String(opts.userId)) violations.push(`sendMessage to chat ${String(body.chat_id)}`);
          const text = String(body.text ?? '');
          transcript.push({ dir: 'bot', text, at: new Date().toISOString() });
          return reply(res, {
            message_id: nextMessageId++,
            date: Math.floor(Date.now() / 1000),
            chat: { id: body.chat_id, type: 'private', first_name: 'E2E' },
            from: BOT_USER,
            text,
          });
        }
        default:
          return reply(res, true);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url,
    token: opts.token,
    userId: opts.userId,
    transcript,
    methods,
    violations,
    polling: () => (pollingStarted ? Promise.resolve() : new Promise<void>((r) => onPolling.push(r))),
    nextPoll() {
      pollingStarted = false;
      return new Promise<void>((r) => onPolling.push(r));
    },
    sendUser(text: string) {
      const command = text.match(/^\/\w+/)?.[0];
      const user = { id: opts.userId, is_bot: false, first_name: 'E2E', language_code: 'uk' };
      updates.push({
        update_id: nextUpdateId++,
        message: {
          message_id: nextMessageId++,
          date: Math.floor(Date.now() / 1000),
          chat: { id: opts.userId, type: 'private', first_name: 'E2E' },
          from: user,
          text,
          ...(command ? { entities: [{ type: 'bot_command', offset: 0, length: command.length }] } : {}),
        },
      });
      transcript.push({ dir: 'user', text, at: new Date().toISOString() });
      wake();
    },
    async waitForBot(pred, { from, timeoutMs, label, abortIf }) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        for (let i = from; i < transcript.length; i++) {
          const line = transcript[i]!;
          if (line.dir === 'bot' && pred(line.text)) return { text: line.text, index: i };
        }
        const abort = abortIf?.();
        const timedOut = Date.now() > deadline;
        if (abort || timedOut) {
          const seen = transcript.slice(from).map((l) => `${l.dir}: ${l.text.slice(0, 160)}`).join('\n  ');
          const why = abort ? `gave up (${abort})` : `timed out after ${Math.round(timeoutMs / 1000)} s`;
          throw new Error(`${why} waiting for the bot to send ${label}. Since then:\n  ${seen || '(nothing)'}`);
        }
        await sleep(100);
      }
    },
    botMessages(from = 0) {
      return transcript.slice(from).filter((l) => l.dir === 'bot').map((l) => l.text);
    },
    reset() {
      transcript.length = 0;
      methods.length = 0;
      violations.length = 0;
      updates = [];
      pollingStarted = false;
      onPolling = [];
    },
    close: () =>
      new Promise<void>((r) => {
        wake();
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
