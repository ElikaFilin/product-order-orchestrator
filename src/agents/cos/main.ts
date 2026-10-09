/**
 * COS process: the Telegram gateway, the COS model session, and the sub-agents it spawns and
 * delegates to over A2A. COS itself serves no A2A endpoint.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { SUB_AGENTS } from '../../config/agents.js';
import { browserConnection, describeBasketBrowser } from '../../browser/connection.js';
import { env } from '../../config/env.js';
import { Telemetry } from '../../observability/telemetry.js';
import { createLogger, errorMessage } from '../../shared/logger.js';
import { runMain } from '../../shared/sub-agent.js';
import { getShop } from '../../shops/index.js';
import { Delegator } from './delegation.js';
import { OrderState } from './order-state.js';
import { detectLang, reply, type Lang } from './replies.js';
import { CosSession } from './session.js';
import { SubagentSupervisor } from './supervisor.js';
import { TelegramGateway, type GatewayCommand } from './telegram.js';
import { CosTools, cosToolServer } from './tools.js';

const SHUTDOWN_STEP_MS = 4_000;

async function main(): Promise<void> {
  const e = env();
  if (!e.TELEGRAM_BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN is not set. Create a bot with @BotFather, put its token into .env and start again.');
  }
  const log = createLogger('cos');
  const setupMode = e.TELEGRAM_ALLOWED_USER_ID === undefined;
  const telemetry = new Telemetry('cos');
  telemetry.status('starting', 'COS starting');

  const shop = getShop(e.DEFAULT_SHOP);
  const state = new OrderState(shop.id);
  const supervisor = new SubagentSupervisor(telemetry);
  const delegator = new Delegator(telemetry);
  const telegram = new TelegramGateway({
    token: e.TELEGRAM_BOT_TOKEN,
    allowedUserId: e.TELEGRAM_ALLOWED_USER_ID,
    apiRoot: e.TELEGRAM_API_ROOT,
    shopName: shop.name,
    telemetry,
    onMessage: (text) => onMessage(text),
    onCommand: (command) => onCommand(command),
    onFatal: () => void shutdown('Telegram polling stopped', 1),
  });
  const tools = new CosTools({
    state,
    delegator,
    supervisor,
    messenger: telegram,
    cartUrl: shop.cartUrl,
    basketBrowser: await describeBasketBrowser(browserConnection(e)),
  });
  // The user writes Ukrainian or English; code's own replies follow their last message.
  let lang: Lang = 'uk';
  const session = new CosSession({
    state,
    telemetry,
    makeToolServer: () => cosToolServer(tools),
    describeQuestions: () => tools.questionsSummary(),
    whenToolsIdle: () => tools.whenIdle(),
    lang: () => lang,
    notify: (text) => telegram.send(text),
  });

  function onMessage(text: string): void {
    lang = detectLang(text) ?? lang;
    // While a delegation runs, the model reads new messages only when the whole current step is done: say so.
    const working = delegator.activeTasks().filter((t) => t.state === 'working' || t.state === 'submitted');
    if (session.busy && working.length > 0) {
      const agents = [...new Set(working.map((t) => t.agent))].join(', ');
      telegram.send(reply(lang, 'busy', agents)).catch((err) => log.warn({ err: errorMessage(err) }, 'acknowledgement failed'));
    }
    session.push(text);
  }

  async function onCommand(command: GatewayCommand): Promise<string> {
    switch (command) {
      case 'status':
        return `${tools.orderState()}\nCOS: ${session.busy ? 'working on your last message' : 'idle'}`;
      case 'stop': {
        const canceled = await tools.cancelAll();
        await session.interrupt();
        return reply(lang, 'stopped', canceled);
      }
      case 'new': {
        await tools.newOrder();
        await session.interrupt();
        session.push('/new: I want to start a new order.');
        return reply(lang, 'newOrder');
      }
    }
  }

  let stopping = false;
  async function shutdown(reason: string, code = 0): Promise<void> {
    if (stopping) return;
    stopping = true;
    log.info({ reason }, 'shutting down');
    telemetry.status('stopped', reason);
    await telemetry.flush(); // before the slow steps: the launcher stops the hub only after COS has exited
    const step = (name: string, work: Promise<unknown>) =>
      Promise.race([
        work.catch((err) => log.warn({ step: name, err: errorMessage(err) }, 'shutdown step failed')),
        delay(SHUTDOWN_STEP_MS, undefined, { ref: false }),
      ]);
    // The launcher allows 10 s after SIGTERM: run the steps side by side, children last.
    await Promise.all([step('telegram', telegram.stop()), step('tasks', delegator.cancelAll()), step('session', session.close())]);
    await supervisor.stopAll();
    await telemetry.shutdown();
    process.exit(code);
  }
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => telemetry.error(err, { source: 'unhandledRejection' }));

  if (setupMode) {
    log.warn('TELEGRAM_ALLOWED_USER_ID is not set: setup mode. Send /start to the bot to learn your id.');
  } else {
    session.start();
    if (e.SUBAGENTS_PRESTART) {
      for (const name of SUB_AGENTS) {
        supervisor.ensureRunning(name).catch((err) => log.error({ agent: name, err: errorMessage(err) }, 'sub-agent prestart failed'));
      }
    }
  }

  try {
    await telegram.start();
  } catch (err) {
    log.error({ err: errorMessage(err) }, 'Telegram bot could not start (check TELEGRAM_BOT_TOKEN)');
    await shutdown('Telegram bot could not start', 1);
    return;
  }
  telemetry.status('idle', setupMode ? 'setup mode' : 'ready');
  log.info({ shop: shop.id, setupMode }, 'COS ready');
}

runMain('cos', main);
