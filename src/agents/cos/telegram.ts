/**
 * Telegram gateway for COS (grammY long polling). Only the one allowed user is served.
 *
 * grammY's bot.start() handles updates one at a time, so a handler that awaited agent work would
 * block every later update, including the user's answer to a question. Handlers here only hand the
 * update to a callback and return.
 */
import { autoRetry } from '@grammyjs/auto-retry';
import { Bot, GrammyError, HttpError } from 'grammy';
import { env } from '../../config/env.js';
import { preview, type Telemetry } from '../../observability/telemetry.js';
import { createLogger, errorMessage } from '../../shared/logger.js';

/** Telegram allows 4096 characters per message; keep a margin. */
export const TELEGRAM_MAX_CHARS = 4_000;

export type GatewayCommand = 'status' | 'stop' | 'new';

export interface TelegramGatewayOptions {
  token: string;
  /** The only user the bot talks to. Undefined = setup mode (the bot only tells people their id). */
  allowedUserId: number | undefined;
  /** Bot API root override (tests use a fake Bot API server). */
  apiRoot?: string;
  shopName: string;
  telemetry: Telemetry;
  /** A text message from the allowed user. Must not block: start the work and return. */
  onMessage(text: string): void;
  /** /status, /stop, /new. The returned text is sent back when it resolves. */
  onCommand(command: GatewayCommand): string | Promise<string>;
  /** Polling stopped because of an unrecoverable error (e.g. invalid token). */
  onFatal?(err: unknown): void;
}

const COMMANDS = [
  { command: 'status', description: 'Order state and running tasks' },
  { command: 'stop', description: 'Stop all running work' },
  { command: 'new', description: 'Start a new order' },
  { command: 'dashboard', description: 'Monitoring links' },
  { command: 'help', description: 'What I can do' },
];

export class TelegramGateway {
  private readonly bot: Bot;
  private readonly log = createLogger('cos:telegram');

  constructor(private readonly opts: TelegramGatewayOptions) {
    this.bot = new Bot(opts.token, opts.apiRoot ? { client: { apiRoot: opts.apiRoot } } : undefined);
    this.bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 }));
    this.bot.catch(({ error, ctx }) => {
      this.log.error({ updateId: ctx.update.update_id, err: describeError(error) }, 'update handler failed');
      opts.telemetry.error(error, { source: 'telegram', updateId: ctx.update.update_id });
    });
    if (opts.allowedUserId === undefined) this.setupMode();
    else this.serve(opts.allowedUserId);
  }

  /** Start long polling; resolves once polling runs, rejects if the bot cannot start. */
  start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let started = false;
      this.bot
        .start({
          drop_pending_updates: true,
          allowed_updates: ['message', 'callback_query'],
          onStart: (me) => {
            started = true;
            this.log.info({ bot: me.username, setupMode: this.opts.allowedUserId === undefined }, 'Telegram polling started');
            void this.bot.api.setMyCommands(COMMANDS).catch((err) => this.log.warn({ err: describeError(err) }, 'setMyCommands failed'));
            resolve();
          },
        })
        .catch((err) => {
          this.log.error({ err: describeError(err) }, 'Telegram polling stopped');
          if (started) this.opts.onFatal?.(err);
          else reject(err);
        });
    });
  }

  async stop(): Promise<void> {
    if (this.bot.isRunning()) await this.bot.stop();
  }

  /** Send plain text to the allowed user, split into Telegram-sized messages on line boundaries. */
  async send(text: string): Promise<void> {
    const chatId = this.opts.allowedUserId;
    if (chatId === undefined) throw new Error('Telegram is in setup mode: TELEGRAM_ALLOWED_USER_ID is not set.');
    const chunks = splitMessage(text);
    for (const chunk of chunks) await this.bot.api.sendMessage(chatId, chunk);
    this.opts.telemetry.emit('telegram', { direction: 'out', text: preview(text, 4_000), messages: chunks.length });
  }

  // ---------- handlers ----------

  private setupMode(): void {
    this.bot.command('start', (ctx) => {
      const id = ctx.from?.id;
      if (id === undefined) return;
      this.log.warn({ userId: id }, 'setup mode: told a user their id');
      void ctx
        .reply(
          `Your Telegram user id is ${id}.\n\nTo let this bot work for you, put this line into the .env file of product-order-orchestrator and restart it:\n\nTELEGRAM_ALLOWED_USER_ID=${id}`,
        )
        .catch((err) => this.log.error({ err: describeError(err) }, 'setup reply failed'));
    });
  }

  private serve(allowedUserId: number): void {
    const { telemetry } = this.opts;
    this.bot.use(async (ctx, next) => {
      if (ctx.from?.id !== allowedUserId) {
        telemetry.emit('telegram', { direction: 'in', blocked: true, fromId: ctx.from?.id });
        return;
      }
      // Every message of the user, commands and non-text ones included, so the transcript has both sides.
      const message = ctx.message;
      if (message) telemetry.emit('telegram', { direction: 'in', text: message.text !== undefined ? preview(message.text, 4_000) : `[${messageKind(message)}]` });
      return next();
    });
    this.bot.command(['start', 'help'], () => this.reply(helpText(this.opts.shopName)));
    this.bot.command('dashboard', () => this.reply(dashboardText()));
    for (const command of ['status', 'stop', 'new'] as const) {
      this.bot.command(command, () => this.reply(Promise.resolve().then(() => this.opts.onCommand(command))));
    }
    this.bot.on('message:text', (ctx) => this.opts.onMessage(ctx.message.text));
    this.bot.on('message', () => this.reply('I can only read text messages.'));
  }

  /** Fire-and-forget reply, so the update handler returns immediately. */
  private reply(text: string | Promise<string>): void {
    void Promise.resolve(text)
      .then((t) => this.send(t))
      .catch((err) => {
        this.log.error({ err: describeError(err) }, 'reply failed');
        this.opts.telemetry.error(err, { source: 'telegram' });
      });
  }
}

/** Split text into chunks of at most `max` chars, preferring line boundaries. */
export function splitMessage(text: string, max = TELEGRAM_MAX_CHARS): string[] {
  const pieces = text.split('\n').flatMap((line) => hardWrap(line, max));
  const chunks: string[] = [];
  let current: string | undefined;
  for (const piece of pieces) {
    if (current === undefined) current = piece;
    else if (current.length + 1 + piece.length <= max) current += `\n${piece}`;
    else {
      chunks.push(current);
      current = piece;
    }
  }
  if (current !== undefined) chunks.push(current);
  return chunks.filter((chunk) => chunk.trim() !== '');
}

function hardWrap(line: string, max: number): string[] {
  const out: string[] = [];
  let rest = line;
  while (rest.length > max) {
    // Never cut a surrogate pair (emoji) in half.
    const cut = /[\uD800-\uDBFF]/.test(rest[max - 1] ?? '') ? max - 1 : max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  out.push(rest);
  return out;
}

function helpText(shopName: string): string {
  return [
    `I'm your Chief of Staff for shopping at ${shopName}. I prepare the shop basket in your own browser and send you the link; checkout and payment stay with you. I never place orders.`,
    '',
    'Examples:',
    '• "хочу замовити" / "I want to order" — I ask which products and how many, fill the basket, check it and send you the basket link.',
    '• save info - add "Печінка індички, 500 г" to product list selection — adds a product to your list, so I offer it next time.',
    '• save info - remove "<product>" from product list — removes it.',
    '',
    'Commands:',
    ...COMMANDS.map((c) => `/${c.command} — ${c.description}`),
  ].join('\n');
}

function dashboardText(): string {
  const e = env();
  const dashboard = e.DASHBOARD_ENABLED
    ? `Agent dashboard: http://${e.DASHBOARD_HOST}:${e.DASHBOARD_PORT}`
    : 'Agent dashboard: disabled (DASHBOARD_ENABLED=0)';
  const traces = e.OTEL_EXPORTER_OTLP_ENDPOINT ? `ClawMetry traces: ${e.CLAWMETRY_URL}` : 'ClawMetry traces: disabled (no OTLP endpoint)';
  return `${dashboard}\n${traces}\n\nThese links open on the Mac that runs the agents.`;
}

const MESSAGE_KINDS = ['photo', 'sticker', 'voice', 'video', 'video_note', 'audio', 'document', 'animation', 'location', 'contact', 'poll'];

/** "photo", "voice", ...: what a non-text message carries. */
function messageKind(message: object): string {
  return MESSAGE_KINDS.find((kind) => kind in message) ?? 'non-text message';
}

function describeError(err: unknown): string {
  if (err instanceof GrammyError) return `${err.method}: ${err.description}`;
  if (err instanceof HttpError) return `network: ${errorMessage(err)}`;
  return errorMessage(err);
}
