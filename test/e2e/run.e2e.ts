/**
 * End-to-end test of the OpenClaw system: a real foreground gateway (repo's pinned openclaw) with our config, our
 * plugin bundle, the four agents and Playwright MCP over CDP. Faked: the Anthropic Messages API (lib/scripted.ts,
 * a scripted model that reads its tool results) and the Telegram Bot API. Each scenario gets a THROWAWAY headless
 * Chrome (fresh profile) that drives the LIVE shop karashynyard.com.ua; the Tilda basket is client-side
 * localStorage, so nothing reaches the shop, and the order form is never touched.
 *
 *   pnpm test:e2e                 # scenarios A, B, C, D
 *   pnpm test:e2e -- --only A,D   # a subset
 *
 * Env: E2E_WORK_DIR (default: a new dir under the OS temp dir), E2E_KEEP=1 (keep it), CHROME_PATH,
 * E2E_PORT_FROM / E2E_PORT_TO (port range, default 9400-9599). Needs Node 24, Chrome and internet access.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { HELPER_SOURCE } from '../../src/core/shops/karashynyard/helper.js';
import { ThrowawayChrome, type CartLine } from './lib/chrome.js';
import { startFakeTelegram, type FakeTelegram } from './lib/fake-telegram.js';
import { E2eGateway, pickPorts } from './lib/gateway.js';
import { startMockAnthropic, type MockAnthropic } from './lib/mock-anthropic.js';
import { parseProductTable, PROBE, QUESTION_HEAD, scriptedPolicy, type Probes } from './lib/scripted.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHOP_ORIGIN = 'https://karashynyard.com.ua';
const SHOP_BASE = 'https://karashynyard.com.ua/';
const CART_URL = 'https://karashynyard.com.ua/#opencart';
const TG_TOKEN = '123456789:E2E-FAKE-TOKEN-not-a-real-bot';
const TG_USER = 424242;
const FILLET = 'Філе зі стегна індички, 1 кг';
const PASTE = 'Горіхова паста з фунндуком 350 г';
const LIVER = 'Печінка курочки, 500 г';
const NEW_PRODUCT = 'Котлети по-київськи з індички, 900 г';
const STEP_MS = Number(process.env.E2E_STEP_MS ?? 4 * 60_000);

/** A tab of "the user" open in the throwaway browser: its title must never reach a model. */
const PRIVATE_TAB_TITLE = 'POO-E2E-PRIVATE-TAB';
const PRIVATE_TAB_URL = `data:text/html,<title>${PRIVATE_TAB_TITLE}</title><p>user mail</p>`;

interface Check {
  scenario: string;
  label: string;
  ok: boolean;
  detail?: string;
}
const checks: Check[] = [];
function check(scenario: string, label: string, ok: boolean, detail?: string): void {
  checks.push({ scenario, label, ok, ...(detail ? { detail } : {}) });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  [${scenario}] ${label}${detail ? `  (${detail})` : ''}\n`);
}

interface World {
  name: string;
  dir: string;
  chrome: ThrowawayChrome;
  mock: MockAnthropic;
  tg: FakeTelegram;
  gw: E2eGateway;
  rows: Map<string, number>;
}

async function withWorld(name: string, workRoot: string, probes: Probes, run: (w: World) => Promise<void>): Promise<void> {
  const dir = path.join(workRoot, name);
  await mkdir(dir, { recursive: true });
  const [gwPort, cdpPort] = await pickPorts(2, Number(process.env.E2E_PORT_FROM ?? 9400), Number(process.env.E2E_PORT_TO ?? 9599));
  const chrome = await ThrowawayChrome.start({ port: cdpPort!, profileDir: path.join(dir, 'chrome-profile'), logFile: path.join(dir, 'chrome.log'), chromePath: process.env.CHROME_PATH });
  const privateTab = await chrome.openPage(PRIVATE_TAB_URL);
  const mock = await startMockAnthropic(scriptedPolicy(probes));
  const tg = await startFakeTelegram({ token: TG_TOKEN, userId: TG_USER });
  const gw = await E2eGateway.start({ repoRoot: REPO, workDir: dir, port: gwPort!, anthropicUrl: mock.url, telegramUrl: tg.url, telegramToken: TG_TOKEN, telegramUserId: TG_USER, cdpUrl: chrome.cdpUrl });
  const skill = await readFile(path.join(gw.workspaceRoot, 'agents/explore/skills/ask-what-to-buy/SKILL.md'), 'utf8');
  const rows = new Map(parseProductTable(skill, 'karashynyard').map((p) => [p.name, p.n]));
  const w: World = { name, dir, chrome, mock, tg, gw, rows };
  try {
    await Promise.race([
      tg.polling(),
      (async () => {
        for (let i = 0; i < 1200 && !gw.exited; i++) await sleep(100);
        throw new Error(gw.exited ?? 'the gateway did not start polling Telegram within 120 s');
      })(),
    ]);
    await run(w);
  } catch (err) {
    check(name, 'scenario completed', false, err instanceof Error ? err.message : String(err));
  } finally {
    const errors = mock.requests.filter((r) => r.error);
    check(name, 'every scripted model step was valid', errors.length === 0, errors.map((r) => `${r.agent}: ${r.error!.split('\n')[0]}`).join(' | '));
    check(name, 'the bot wrote only to the owner', tg.violations.length === 0, tg.violations.join('; '));
    const leaked = mock.requests.filter((r) => JSON.stringify(r.body).includes(PRIVATE_TAB_TITLE));
    check(name, "the user's other tab never reached a model", leaked.length === 0, leaked.map((r) => `${r.agent}#${r.seq}`).join(', '));
    const placeholders = mock.requests.filter((r) => JSON.stringify(r.body).includes('[MISSING] Expected at:'));
    check(name, 'no prompt carries a [MISSING] workspace file', placeholders.length === 0, placeholders.map((r) => `${r.agent}#${r.seq}`).join(', '));
    const cosPrompts = mock.requests.filter((r) => r.agent === 'cos');
    const withFiles = cosPrompts.filter((r) => ['agents/cos/SOUL.md', 'agents/cos/MEMORY.md'].every((f) => JSON.stringify(r.body).includes(f)));
    check(name, "COS's SOUL.md and MEMORY.md are in every COS prompt", cosPrompts.length > 0 && withFiles.length === cosPrompts.length, `${withFiles.length}/${cosPrompts.length}`);
    await writeFile(path.join(dir, 'transcript.json'), JSON.stringify({ telegram: tg.transcript, requests: mock.requests.map((r) => ({ seq: r.seq, agent: r.agent, reply: r.reply, error: r.error })) }, null, 1));
    await writeFile(path.join(dir, 'model-requests.json'), JSON.stringify(mock.requests, null, 1));
    await gw.stop();
    await privateTab.close().catch(() => undefined);
    await chrome.stop();
    await tg.close();
    await mock.close();
  }
}

/** The user's next message and the bot's first answer that matches. */
async function say(w: World, text: string, expect: (t: string) => boolean, label: string): Promise<string> {
  const from = w.tg.transcript.length;
  w.tg.sendUser(text);
  return (await w.tg.waitForBot(expect, { from, timeoutMs: STEP_MS, label, abortIf: () => w.gw.exited })).text;
}

const isQuestion = (t: string) => t.startsWith(QUESTION_HEAD);
const hasLink = (t: string) => t.includes(CART_URL);
const sameLines = (a: CartLine[], b: Array<{ name: string; qty: number }>) =>
  JSON.stringify([...a].filter((l) => l.qty > 0).map((l) => [l.name, l.qty]).sort()) === JSON.stringify([...b].map((l) => [l.name, l.qty]).sort());

/** The order flow: question, answer, then the bot's link. Returns the final message. */
async function order(w: World, answer: string): Promise<string> {
  const question = await say(w, 'хочу замовити', isQuestion, 'the product question');
  check(w.name, 'COS relays the product question word for word', question.includes(`${w.rows.get(FILLET)}. ${FILLET}`));
  return say(w, answer, hasLink, 'the basket link');
}

async function verifyBasket(w: World, expected: Array<{ name: string; qty: number }>): Promise<void> {
  const stored = await w.chrome.readCart(SHOP_ORIGIN);
  check(w.name, 'the browser basket holds exactly the order', sameLines(stored.lines, expected), JSON.stringify(stored.lines));
  const viaLink = await w.chrome.openCartLink(CART_URL, HELPER_SOURCE);
  check(w.name, 'the link opens the prepared basket', Boolean(viaLink?.open) && sameLines(viaLink!.lines, expected), JSON.stringify(viaLink));
  const order = w.gw.orderState();
  check(w.name, 'QA verified the basket in its window before the link', order.lastQa?.verdict === 'match' && order.lastQa.modalOpened === true);
}

// ---------- scenarios ----------

const SCENARIOS: Record<string, { probes: Probes; run: (w: World) => Promise<void> }> = {
  A: {
    probes: { forbidden: false },
    async run(w) {
      const final = await order(w, `${w.rows.get(FILLET)} - 2\n${w.rows.get(PASTE)}`);
      check(w.name, 'the final message carries the link', hasLink(final), final);
      await verifyBasket(w, [{ name: FILLET, qty: 2 }, { name: PASTE, qty: 1 }]);
      const agents = new Set(w.mock.requests.map((r) => r.agent));
      check(w.name, 'all four agents ran inside the gateway', ['cos', 'explore', 'execute', 'qa'].every((a) => agents.has(a)), [...agents].join(','));
    },
  },
  B: {
    probes: { forbidden: false },
    async run(w) {
      const seedLiver = () => w.chrome.withShopHelper(SHOP_BASE, HELPER_SOURCE, `window.__poo.setQty(${JSON.stringify(LIVER)}, 1)`);
      // A new order starts from an empty basket: Execute first removes what an earlier order left.
      await seedLiver();
      const first = await order(w, `${w.rows.get(FILLET)}`);
      check(w.name, 'the new order gets the link without a mismatch', hasLink(first));
      await verifyBasket(w, [{ name: FILLET, qty: 1 }]);
      const cleared = w.gw.tasks().some((t) => t.agent === 'execute' && (t.result as { cleared?: string[] } | undefined)?.cleared?.includes(LIVER));
      check(w.name, 'Execute cleared the line of the earlier order', cleared);

      // Adding to the current order keeps the basket: the extra line stays, QA reports it, and a fix removes it.
      await seedLiver();
      await say(w, `add ${w.rows.get(PASTE)}`, (t) => t.includes('відрізняється'), 'the mismatch report');
      const final = await say(w, 'прибери зайве', hasLink, 'the basket link after the fix');
      check(w.name, 'the link comes after the fix and the re-check', hasLink(final));
      await verifyBasket(w, [{ name: FILLET, qty: 1 }, { name: PASTE, qty: 1 }]);
      const qaTasks = w.mock.requests.filter((r) => r.agent === 'qa' && JSON.stringify(r.body).includes(`\\"${LIVER}\\": must no longer be in the basket`));
      check(w.name, 'the re-check knows what to check (the extra line is gone)', qaTasks.length > 0);
    },
  },
  C: {
    probes: { forbidden: false },
    async run(w) {
      const saved = await say(w, `save info - add "${NEW_PRODUCT}" to product list selection`, (t) => t.startsWith('Збережено'), 'the save confirmation');
      check(w.name, 'COS confirms the product list update', saved.startsWith('Збережено'));
      const skill = await readFile(path.join(w.gw.workspaceRoot, 'agents/explore/skills/ask-what-to-buy/SKILL.md'), 'utf8');
      check(w.name, 'the skill lists the new product', skill.includes(`| ${NEW_PRODUCT} |`));

      // "save this": COS writes its memory, and every new order gets the product.
      const remembered = await say(w, `save this - add ${FILLET} to every future order`, (t) => t.startsWith('Запам'), 'the memory confirmation');
      check(w.name, 'COS confirms what it remembered', remembered.includes(FILLET), remembered);
      const memory = await readFile(path.join(w.gw.workspaceRoot, 'agents/cos/MEMORY.md'), 'utf8');
      check(w.name, "COS's MEMORY.md holds the every-order product", memory.includes(`- ${FILLET} × 1`), memory);

      const question = await say(w, 'хочу замовити', isQuestion, 'the product question');
      check(w.name, 'the next question lists the new product', /\d+\. Котлети по-київськи з індички, 900 г/.test(question));
      check(w.name, 'the question says the saved product is always added', question.includes(`Завжди додається до замовлення: ${FILLET} × 1.`), question);
      const final = await say(w, `${w.rows.get(PASTE)}`, hasLink, 'the basket link');
      check(w.name, 'the order with the saved product gets the link', hasLink(final));
      await verifyBasket(w, [{ name: FILLET, qty: 1 }, { name: PASTE, qty: 1 }]);
    },
  },
  D: {
    probes: { forbidden: true },
    async run(w) {
      const final = await order(w, `${w.rows.get(FILLET)}`);
      check(w.name, 'the order still completes', hasLink(final));
      check(w.name, 'the early basket link never reached the user', !w.tg.botMessages().some((t) => t.startsWith('Ось кошик')));
      await verifyBasket(w, [{ name: FILLET, qty: 1 }]);
      // Every attempt is refused and recorded in the session transcripts the Control UI shows.
      const sessions = new Map(w.gw.tasks().map((t) => [t.agent, t.childSessionKey!]));
      const refused = async (sessionKey: string, pick: (args: string) => boolean) => {
        const messages = await w.gw.history(sessionKey);
        await writeFile(path.join(w.dir, `history-${sessionKey.replace(/[^\w-]+/g, '_')}.json`), JSON.stringify(messages, null, 1));
        const calls = new Map<string, string>();
        for (const m of messages) {
          for (const block of Array.isArray(m.content) ? m.content : []) if (block?.type === 'toolCall') calls.set(block.id, JSON.stringify(block.arguments ?? {}));
        }
        // A call of a tool the agent does not have is recorded as its result only ("Tool … not found").
        return messages
          .filter((m) => m.role === 'toolResult' && m.isError === true && pick(`${m.toolName} ${calls.get(m.toolCallId) ?? ''}`))
          .map((m) => JSON.stringify(m.content));
      };
      const expectRefused = async (label: string, sessionKey: string | undefined, pick: (args: string) => boolean) => {
        const found = sessionKey ? await refused(sessionKey, pick) : [];
        check(w.name, `refused and recorded: ${label}`, found.length > 0, found[0]?.slice(0, 160));
      };
      await expectRefused('COS sends the basket link before verification', 'agent:cos:main', (a) => a.includes('{{cart_link}}'));
      await expectRefused('COS writes a file other than its memory', 'agent:cos:main', (a) => a.startsWith('write ') && a.includes(PROBE.cosWrite));
      await expectRefused('Explore reads a file outside its skill', sessions.get('explore'), (a) => a.includes(PROBE.exploreRead));
      await expectRefused('Execute navigates to another site', sessions.get('execute'), (a) => a.includes(PROBE.executeNavigate));
      await expectRefused('Execute runs free JavaScript', sessions.get('execute'), (a) => a.includes('document.title'));
      await expectRefused('Execute touches the order form', sessions.get('execute'), (a) => a.includes('Відправити замовлення'));
      await expectRefused('Execute clicks', sessions.get('execute'), (a) => a.startsWith('playwright__browser_click'));
      await expectRefused('QA changes the basket', sessions.get('qa'), (a) => a.includes('setQty'));
      await expectRefused('a sub-agent messages the user', sessions.get('qa'), (a) => a.startsWith('message '));
    },
  },
};

async function main(): Promise<void> {
  const only = process.argv.join(' ').match(/--only\s+([A-Z,]+)/)?.[1]?.split(',') ?? Object.keys(SCENARIOS);
  await promisify(execFile)(process.execPath, [path.join(REPO, 'scripts', 'build-plugin.mjs')]);
  const workRoot = process.env.E2E_WORK_DIR ?? (await mkdtemp(path.join(os.tmpdir(), 'poo-e2e-')));
  process.stdout.write(`e2e work dir: ${workRoot}\n`);
  for (const name of only) {
    const scenario = SCENARIOS[name];
    if (!scenario) throw new Error(`unknown scenario ${name}`);
    process.stdout.write(`\n== scenario ${name}\n`);
    await withWorld(name, workRoot, scenario.probes, scenario.run);
  }
  const failed = checks.filter((c) => !c.ok);
  await writeFile(path.join(workRoot, 'report.json'), JSON.stringify({ checks }, null, 1));
  process.stdout.write(`\n${failed.length === 0 ? 'E2E OK' : `E2E FAILED: ${failed.length} check(s)`} (${checks.length} checks; report ${path.join(workRoot, 'report.json')})\n`);
  if (!process.env.E2E_KEEP && failed.length === 0 && !process.env.E2E_WORK_DIR) await rm(workRoot, { recursive: true, force: true });
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((err) => {
  process.stderr.write(`e2e failed to run: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
