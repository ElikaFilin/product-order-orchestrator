/**
 * Full end-to-end test of the REAL system: `src/launcher.ts` (dashboard hub + COS; COS spawns Explore,
 * Execute and QA through its supervisor), the real Claude Code CLI under every agent (our options: tool
 * surfaces, skills, allowedTools, guard hooks incl. eval rewriting, structured output), real A2A between
 * COS and the sub-agents, Playwright MCP (Execute) and agent-browser MCP (QA) over CDP, telemetry to the
 * hub and to an OTLP receiver. Faked: the Anthropic Messages API (a local scripted mock, see
 * lib/scripted-agents.ts) and the Telegram Bot API (lib/fake-telegram.ts). The browser is a THROWAWAY
 * headless Chrome per scenario (fresh temp profile) driving the LIVE shop karashynyard.com.ua; the Tilda
 * basket is client-side localStorage, so nothing reaches the shop. The order form is never touched.
 *
 * The run uses a temporary copy of the repository (src, agents, package.json, tsconfig.json; node_modules
 * symlinked), so the product-list edit of scenario C never touches the real
 * agents/explore/.claude/skills/ask-what-to-buy/SKILL.md.
 *
 *   pnpm test:e2e                 # scenarios A, B, C
 *   pnpm test:e2e -- --only A,C   # a subset
 *
 * Env: E2E_WORK_DIR (default: a new dir under the OS temp dir), E2E_KEEP=1 (keep the repo copy),
 * CHROME_PATH, E2E_PORT_FROM / E2E_PORT_TO (port scan range, default 9400-9599).
 * Needs Node 24, Google Chrome and internet access to karashynyard.com.ua. Not part of `pnpm test`.
 */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { Client } from '@a2a-js/sdk/client';
import { artifactData, createA2AClient, dataOf, Role, stateName, textOf } from '../../src/shared/a2a.js';
import { HELPER_SOURCE } from '../../src/shops/karashynyard/helper.js';
import { ThrowawayChrome, type CartLine } from './lib/chrome.js';
import { startFakeTelegram, type FakeTelegram } from './lib/fake-telegram.js';
import { startMockAnthropic, type CapturedRequest, type MockAnthropic } from './lib/mock-anthropic.js';
import { startOtlpCollector, type OtlpCollector } from './lib/otlp-collector.js';
import { Conversation, parseProductTable, QUESTION_HEAD, scriptedPolicy } from './lib/scripted-agents.js';
import { pickPorts, RunningSystem, type StopReport } from './lib/system.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SKILL_REL = path.join('agents', 'explore', '.claude', 'skills', 'ask-what-to-buy', 'SKILL.md');
const SHOP_ORIGIN = 'https://karashynyard.com.ua';
const SHOP_BASE = 'https://karashynyard.com.ua/';
const CART_URL = 'https://karashynyard.com.ua/#opencart';
const NEW_PRODUCT = 'Котлети по-київськи з індички, 900 г';
const TG_TOKEN = '123456789:E2E-FAKE-TOKEN-not-a-real-bot';
const TG_USER = 424242;
const FAKE_API_KEY = 'sk-ant-e2e-fake-key-local-mock-only';

const FILLET = 'Філе зі стегна індички, 1 кг';
const PASTE = 'Горіхова паста з фунндуком 350 г';
const LIVER = 'Печінка курочки, 500 г';

const STEP_MS = 4 * 60_000;
const FLOW_MS = 8 * 60_000;

/** A tab of "the user" open in the throwaway browser during every scenario: its title must never leak. */
const PRIVATE_TAB_TITLE = 'POO-E2E-PRIVATE-TAB';
const PRIVATE_TAB_URL = `data:text/html,<title>${PRIVATE_TAB_TITLE}</title><p>user mail</p>`;
/** COS's own "I got your message, the agents are busy" reply, in Ukrainian or English. */
const ACK = /^(Got it\.|Прийняв\.)/;

const COS_TOOLS = [
  'send_telegram',
  'relay_question',
  'delegate_task',
  'answer_subagent',
  'cancel_subagent',
  'get_order_state',
  'accept_basket_items',
  'new_order',
].map((t) => `mcp__cos__${t}`);
const BUILTINS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'TodoWrite', 'NotebookEdit'];

// ---------- reporting ----------

interface Check {
  scenario: string;
  label: string;
  ok: boolean;
  detail?: string;
}
const checks: Check[] = [];
const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
const log = (text: string) => process.stdout.write(`${stamp()}  ${text}\n`);

function check(scenario: string, label: string, ok: boolean, detail?: string): boolean {
  checks.push({ scenario, label, ok, ...(detail ? { detail } : {}) });
  const flat = detail?.replace(/\s*\n\s*/g, ' / ');
  process.stdout.write(`${stamp()}  ${ok ? 'PASS' : 'FAIL'} [${scenario}] ${label}${flat ? `  (${flat})` : ''}\n`);
  return ok;
}

interface Note {
  scenario: string;
  text: string;
}
const notes: Note[] = [];
/** A known product behaviour worth seeing in every run that does not fail the e2e (see the report). */
function note(scenario: string, text: string): void {
  notes.push({ scenario, text });
  process.stdout.write(`${stamp()}  NOTE [${scenario}] ${text}\n`);
}

const short = (v: unknown, max = 300) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

// ---------- shared state ----------

interface HubEvent {
  ts: string;
  agent: string;
  kind: string;
  taskId?: string;
  contextId?: string;
  traceId?: string;
  data: Record<string, unknown>;
}

interface TaskEvidence {
  agent: string;
  taskId: string;
  /** States COS saw for this task, in order (from its a2a receive events). */
  timeline: string[];
  state: string;
  statusText: string;
  /** The typed payload COS sent (first data part of the first user message). */
  request?: Record<string, unknown>;
  userTexts: string[];
  result?: Record<string, unknown>;
  fetchError?: string;
}

interface BoardAgent {
  agent: string;
  state: string;
  detail?: string;
  toolCalls: number;
  errors: number;
  costUsd: number;
}

interface Evidence {
  events: HubEvent[];
  tasks: TaskEvidence[];
  /** The dashboard's derived views (/api/agents, /api/tasks). */
  board: BoardAgent[];
  boardTasks: Array<{ taskId: string; agent: string; state: string }>;
  byAgent(agent: string): TaskEvidence[];
}

interface Ports {
  chrome: number;
  explore: number;
  execute: number;
  qa: number;
  hub: number;
}

interface Ctx {
  id: string;
  dir: string;
  repoDir: string;
  ports: Ports;
  tg: FakeTelegram;
  mock: MockAnthropic;
  mockFrom: number;
  chrome: ThrowawayChrome;
  hubUrl: string;
  check(label: string, ok: boolean, detail?: string): boolean;
  say(text: string): number;
  waitBot(pred: (t: string) => boolean, label: string, from: number, timeoutMs?: number): Promise<string>;
  requests(agent?: string): CapturedRequest[];
  /** Wait until the dashboard hub has an event matching the query (e.g. agent=execute&kind=tool_call). */
  waitHub(query: string, label: string, timeoutMs?: number): Promise<void>;
  evidence(): Promise<Evidence>;
  cart(): Promise<CartLine[]>;
}

interface Scenario {
  id: string;
  title: string;
  /** Sub-agents this scenario must spawn and use. */
  agents: Array<'explore' | 'execute' | 'qa'>;
  /** "Got it, I'll read this when ... finishes" acknowledgements the scenario provokes on purpose. */
  acks: number;
  run(ctx: Ctx): Promise<void>;
}

// ---------- helpers ----------

const sameCart = (actual: CartLine[], expected: CartLine[]) => {
  const norm = (l: CartLine[]) =>
    l
      .map((x) => `${x.name}×${x.qty}`)
      .sort()
      .join(' | ');
  return norm(actual) === norm(expected);
};
const cartText = (l: CartLine[]) => l.map((x) => `${x.name} ×${x.qty}`).join('; ') || '(empty)';

async function hubEvents(hubUrl: string): Promise<HubEvent[]> {
  const res = await fetch(`${hubUrl}/api/events?limit=5000`, { signal: AbortSignal.timeout(5_000) });
  return ((await res.json()) as { events: HubEvent[] }).events;
}

async function collectTasks(events: HubEvent[], ports: Ports): Promise<TaskEvidence[]> {
  const order: TaskEvidence[] = [];
  const byId = new Map<string, TaskEvidence>();
  for (const e of events) {
    if (e.agent !== 'cos' || e.kind !== 'a2a' || !e.taskId || e.data.direction !== 'receive') continue;
    let t = byId.get(e.taskId);
    if (!t) {
      t = { agent: String(e.data.from), taskId: e.taskId, timeline: [], state: '?', statusText: '', userTexts: [] };
      byId.set(e.taskId, t);
      order.push(t);
    }
    const s = String(e.data.state);
    if (t.timeline.at(-1) !== s) t.timeline.push(s);
  }
  const clients = new Map<string, Promise<Client>>();
  for (const t of order) {
    const port = ports[t.agent as keyof Ports];
    try {
      let client = clients.get(t.agent);
      if (!client) {
        client = createA2AClient(`http://127.0.0.1:${port}`);
        clients.set(t.agent, client);
      }
      const task = await (await client).getTask({ tenant: '', id: t.taskId }, { signal: AbortSignal.timeout(10_000) });
      t.state = stateName(task.status?.state);
      t.statusText = textOf(task.status?.message?.parts);
      const users = (task.history ?? []).filter((m) => m.role === Role.ROLE_USER);
      t.userTexts = users.map((m) => textOf(m.parts));
      const req = dataOf(users[0]?.parts)[0];
      if (req && typeof req === 'object') t.request = req as Record<string, unknown>;
      const res = artifactData(task)[0];
      if (res && typeof res === 'object') t.result = res as Record<string, unknown>;
    } catch (err) {
      t.fetchError = err instanceof Error ? err.message : String(err);
    }
  }
  return order;
}

function toolSet(req: CapturedRequest | undefined): string[] {
  return ((req?.body.tools as Array<{ name: string }> | undefined) ?? []).map((t) => t.name).sort();
}

/** Tool calls the scripted model made, per agent, in this scenario. */
function modelCalls(reqs: CapturedRequest[], agent: string): string[] {
  return reqs.filter((r) => r.agent === agent && r.reply?.kind === 'tool_use').map((r) => (r.reply as { name: string }).name);
}

function firstUserText(req: CapturedRequest): string {
  return new Conversation(req.body).firstUserText();
}

async function sha256(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

/** The link in COS's final message must open the prepared basket in the browser that holds it. */
async function checkCartLink(ctx: Ctx, finalMessage: string, expected: CartLine[]): Promise<void> {
  const link = finalMessage.split('\n').find((l) => /^https?:\/\//.test(l.trim()))?.trim();
  if (!ctx.check('final message has a link', !!link, link)) return;
  const view = await ctx.chrome.openCartLink(link!, HELPER_SOURCE);
  ctx.check(
    'opening that link in the browser shows the prepared basket in the cart window',
    !!view?.open && sameCart(view.lines, expected),
    view ? cartText(view.lines) : 'the cart window did not open',
  );
}

// ---------- scenarios ----------

const scenarioA: Scenario = {
  id: 'A',
  title: 'happy path: order -> question -> selection -> fill basket -> QA match -> link',
  agents: ['explore', 'execute', 'qa'],
  acks: 1,
  async run(ctx) {
    const c = ctx.check.bind(ctx);
    const before = await ctx.cart();
    c('fresh throwaway profile starts with an empty basket', before.length === 0, cartText(before));

    let from = ctx.say('хочу замовити');
    const question = await ctx.waitBot((t) => t.startsWith(QUESTION_HEAD), 'the product question', from);
    const asked = ctx.requests('explore').flatMap((r) =>
      r.reply?.kind === 'tool_use' && r.reply.name === 'mcp__explore__ask_user' ? [String(r.reply.input.question)] : [],
    );
    c('COS relayed the Explore question to Telegram verbatim', asked.includes(question), `${asked.length} ask_user call(s)`);
    const numbered = question.match(/^\d+\. /gm)?.length ?? 0;
    c('the question lists the 21 products of the skill, numbered', numbered === 21, `${numbered} numbered lines`);
    c('the list uses exact shop names', question.includes(`21. ${PASTE} — ≈850 грн`) && question.includes(`1. ${FILLET}`));

    from = ctx.say('1 - 2\n21');
    const confirm = await ctx.waitBot((t) => t.startsWith('Ваш вибір'), 'the selection confirmation', from);
    c('COS confirmed the selection', confirm.includes(`${FILLET} × 2`) && confirm.includes(`${PASTE} × 1`), short(confirm));

    // The user writes while Execute works: the gateway must not block, must acknowledge, and must not lose it.
    await ctx.waitHub('agent=execute&kind=tool_call', 'the execute agent at work');
    const midFlow = ctx.say('як там?');
    const ack = await ctx.waitBot((t) => ACK.test(t), 'the acknowledgement of a message sent mid-flow', midFlow, 20_000);
    c(
      'a message sent while Execute works is acknowledged at once, in the user language',
      ack.startsWith('Прийняв.') && /агент (execute|qa)/.test(ack),
      short(ack),
    );

    const final = await ctx.waitBot((t) => t.includes(CART_URL), 'the final message with the cart link', from, FLOW_MS);
    c('final message lists the verified basket', final.includes(`${FILLET} × 2`) && final.includes(`${PASTE} × 1`), short(final));
    c('final message carries the cart link on its own line', final.split('\n').includes(CART_URL));
    const status = await ctx.waitBot((t) => t.startsWith('Стан замовлення'), 'the answer to the queued mid-flow message', midFlow);
    const order = ctx.tg.transcript.map((l) => l.text);
    c(
      'the queued message reached COS as its next turn, after the final message',
      order.indexOf(status) > order.indexOf(final) && status.includes('Basket verified'),
      short(status),
    );

    const ev = await ctx.evidence();
    const [explore] = ev.byAgent('explore');
    const [execute] = ev.byAgent('execute');
    const [qa] = ev.byAgent('qa');
    c('A2A explore task: input-required round trip, then completed', !!explore && explore.timeline.includes('input-required') && explore.state === 'completed', short(explore?.timeline));
    c('A2A explore task history holds the user answer (same taskId)', !!explore?.userTexts.includes('1 - 2\n21'), short(explore?.userTexts));
    const sel = explore?.result as { type?: string; items?: Array<{ name: string; qty: number; sku?: string }> } | undefined;
    c(
      'Explore returned a Selection artifact with exact names and SKUs',
      sel?.type === 'selection' && sameCart(sel.items ?? [], [{ name: FILLET, qty: 2 }, { name: PASTE, qty: 1 }]) && sel.items?.find((i) => i.name === PASTE)?.sku === '513',
      short(sel),
    );
    const execReq = execute?.request as { type?: string; mode?: string; ops?: Array<{ name: string; targetQty: number }> } | undefined;
    c('COS built the execute-request (initial) from the selection', execReq?.type === 'execute-request' && execReq.mode === 'initial' && execReq.ops?.length === 2, short(execReq));
    const execRes = execute?.result as { type?: string; ops?: Array<{ name: string; status: string; actualQty?: number }> } | undefined;
    c(
      'A2A execute task completed, every operation ok with read-back quantities',
      execute?.state === 'completed' && execRes?.type === 'execute-result' && !!execRes.ops?.every((o) => o.status === 'ok') &&
        execRes.ops?.find((o) => o.name === FILLET)?.actualQty === 2,
      short(execRes?.ops),
    );
    const qaRes = qa?.result as { type?: string; verdict?: string; modalOpened?: boolean; differences?: unknown[]; cart?: CartLine[]; notes?: string } | undefined;
    c(
      'A2A qa task completed with verdict "match", read from the open basket window',
      qa?.state === 'completed' && qaRes?.verdict === 'match' && qaRes.modalOpened === true && qaRes.differences?.length === 0,
      short(qaRes),
    );
    c(
      'QA verdict was computed from the page data the browser returned, not from lines the model retyped',
      !!qaRes && !/not captured/.test(qaRes.notes ?? ''),
      short(qaRes?.notes),
    );
    const qaReq = qa?.request as { focus?: unknown[] } | undefined;
    c('the first QA check after the initial fill has no "re-check" focus', qaReq?.focus?.length === 0, short(qaReq?.focus));

    const cart = await ctx.cart();
    c('the real basket (localStorage tcart) holds exactly the selection', sameCart(cart, [{ name: FILLET, qty: 2 }, { name: PASTE, qty: 1 }]), cartText(cart));
    await checkCartLink(ctx, final, [{ name: FILLET, qty: 2 }, { name: PASTE, qty: 1 }]);
  },
};

const scenarioB: Scenario = {
  id: 'B',
  title: 'mismatch + fix: a pre-seeded extra line -> QA mismatch -> user "прибери зайве" -> fix -> focused re-check -> link',
  agents: ['explore', 'execute', 'qa'],
  acks: 0,
  async run(ctx) {
    const c = ctx.check.bind(ctx);
    const seeded = await ctx.chrome.withShopHelper<{ status?: string; after?: number; detail?: string }>(
      SHOP_BASE,
      HELPER_SOURCE,
      `window.__poo.setQty(${JSON.stringify(LIVER)}, 1)`,
    );
    c('pre-seeded an extra line with the in-page helper', seeded?.status === 'ok' && seeded.after === 1, short(seeded));
    const before = await ctx.cart();
    c('basket before the run holds only the extra line', sameCart(before, [{ name: LIVER, qty: 1 }]), cartText(before));

    let from = ctx.say('хочу замовити');
    await ctx.waitBot((t) => t.startsWith(QUESTION_HEAD), 'the product question', from);
    from = ctx.say('1\n21 - 2');
    await ctx.waitBot((t) => t.startsWith('Ваш вибір'), 'the selection confirmation', from);
    const diff = await ctx.waitBot((t) => t.startsWith('Кошик відрізняється'), 'the differences report', from, FLOW_MS);
    c('COS reported the extra line to the user', diff.includes(`${LIVER}: очікувалось 0, у кошику 1`), short(diff));
    c('no cart link before the basket is verified', !ctx.tg.botMessages(from).some((t) => t.includes(CART_URL)));

    from = ctx.say('прибери зайве');
    const final = await ctx.waitBot((t) => t.includes(CART_URL), 'the final message with the cart link', from, FLOW_MS);
    c('final message lists the fixed basket', final.includes(`${FILLET} × 1`) && final.includes(`${PASTE} × 2`) && !final.includes(LIVER), short(final));

    const ev = await ctx.evidence();
    const executes = ev.byAgent('execute');
    const qas = ev.byAgent('qa');
    c('two execute tasks (initial, fix) and two qa tasks', executes.length === 2 && qas.length === 2, `execute ${executes.length}, qa ${qas.length}`);
    const qa1 = qas[0]?.result as { verdict?: string; differences?: Array<{ kind: string; name: string; actualQty: number }> } | undefined;
    c(
      'QA #1 verdict "mismatch" with exactly the extra line',
      qa1?.verdict === 'mismatch' && qa1.differences?.length === 1 && qa1.differences[0]?.kind === 'extra' && qa1.differences[0]?.name === LIVER,
      short(qa1?.differences),
    );
    const fixReq = executes[1]?.request as { mode?: string; ops?: Array<{ name: string; targetQty: number }> } | undefined;
    c('Execute fix request: remove the extra line (targetQty 0)', fixReq?.mode === 'fix' && fixReq.ops?.length === 1 && fixReq.ops[0]?.name === LIVER && fixReq.ops[0]?.targetQty === 0, short(fixReq));
    const fixRes = executes[1]?.result as { ops?: Array<{ status: string; actualQty?: number }> } | undefined;
    c('Execute fix completed ok (line gone)', executes[1]?.state === 'completed' && fixRes?.ops?.[0]?.status === 'ok' && fixRes.ops[0]?.actualQty === 0, short(fixRes?.ops));
    const qa2Req = qas[1]?.request as { focus?: Array<{ name: string; check: string }> } | undefined;
    c('QA #2 request carries the re-check focus "absent" for the removed line', qa2Req?.focus?.length === 1 && qa2Req.focus[0]?.check === 'absent' && qa2Req.focus[0]?.name === LIVER, short(qa2Req?.focus));
    const qa2Prompts = ctx.requests('qa').map(firstUserText).filter((t) => t.includes('Check these lines with extra care'));
    c('QA #2 prompt tells the model what to re-check', qa2Prompts.some((t) => t.includes(`"${LIVER}": must no longer be in the basket`)), `${qa2Prompts.length} re-check prompt(s)`);
    const qa2 = qas[1]?.result as { verdict?: string; focus?: Array<{ check: string; passed: boolean }> } | undefined;
    c('QA #2 verdict "match" and the focus check passed', qa2?.verdict === 'match' && !!qa2.focus?.every((f) => f.passed) && qa2.focus?.length === 1, short(qa2));

    const cart = await ctx.cart();
    c('the real basket holds exactly the selection after the fix', sameCart(cart, [{ name: FILLET, qty: 1 }, { name: PASTE, qty: 2 }]), cartText(cart));
    await checkCartLink(ctx, final, [{ name: FILLET, qty: 1 }, { name: PASTE, qty: 2 }]);
  },
};

const scenarioC: Scenario = {
  id: 'C',
  title: 'save info: add a product to the list -> skill file updated -> next question lists it',
  agents: ['explore'],
  acks: 0,
  async run(ctx) {
    const c = ctx.check.bind(ctx);
    const skillFile = path.join(ctx.repoDir, SKILL_REL);
    const before = parseProductTable(await readFile(skillFile, 'utf8'), 'karashynyard');
    c('skill copy starts with 21 products', before.length === 21, `${before.length}`);

    let from = ctx.say(`save info - add "${NEW_PRODUCT}" to product list selection`);
    const saved = await ctx.waitBot((t) => t.startsWith('Збережено'), 'the save confirmation', from);
    c('COS confirmed the list update', saved.includes(NEW_PRODUCT) && saved.includes('22'), short(saved));

    const text = await readFile(skillFile, 'utf8');
    const after = parseProductTable(text, 'karashynyard');
    c('the skill file now has 22 products, the new one as #22', after.length === 22 && after[21]?.name === NEW_PRODUCT && after[21]?.n === 22, `${after.length}, last: ${after.at(-1)?.name}`);
    c('the old 21 rows are unchanged', before.every((p, i) => after[i]?.name === p.name && after[i]?.sku === p.sku));
    c('skill metadata version was bumped', /version:\s*"2"/.test(text));

    from = ctx.say('хочу замовити');
    const question = await ctx.waitBot((t) => t.startsWith(QUESTION_HEAD), 'the next product question', from);
    const numbered = question.match(/^\d+\. /gm)?.length ?? 0;
    c('the next select-products question lists the new product', question.includes(`22. ${NEW_PRODUCT}`) && numbered === 22, `${numbered} numbered lines`);
    const skillDirs = new Set(
      ctx.requests('explore').flatMap((r) => [...JSON.stringify(r.body).matchAll(/Base directory for this skill: ([^\\"]+)/g)].map((m) => m[1]!)),
    );
    c(
      'Explore loaded the skill from the temporary repo copy (the real SKILL.md is never used)',
      // macOS temp dirs live under /var, a symlink to /private/var: compare real paths.
      skillDirs.size === 1 && realpathSync([...skillDirs][0]!) === realpathSync(path.dirname(skillFile)),
      [...skillDirs].join(', '),
    );

    from = ctx.say('/status');
    const status = await ctx.waitBot((t) => t.includes('Pending sub-agent questions'), 'the /status reply', from, 60_000);
    c('/status shows the waiting explore question', status.includes('Pending sub-agent questions: 1') && /explore task \S+: input-required/.test(status), short(status, 500));

    from = ctx.say('/stop');
    const stoppedAt = Date.now();
    const stopped = await ctx.waitBot((t) => t.startsWith('Зупинив.'), 'the /stop reply (in Ukrainian)', from, 60_000);
    c('/stop canceled the waiting explore task', stopped.includes('Скасовано завдань: 1'), short(stopped));
    await sleep(3_000);
    const lateExplore = ctx.requests('explore').filter((r) => Date.parse(r.at) > stoppedAt);
    c('the canceled explore run made no more model calls (its turn was interrupted)', lateExplore.length === 0, `${lateExplore.length} request(s) after /stop`);

    const ev = await ctx.evidence();
    const [update, select] = ev.byAgent('explore');
    const upd = update?.result as { type?: string; added?: string[]; products?: string[] } | undefined;
    c('A2A update-product-list task completed with the ProductListUpdate artifact', update?.state === 'completed' && upd?.type === 'product-list-update' && upd.added?.[0] === NEW_PRODUCT && upd.products?.length === 22, short(upd));
    c('COS sent explore-request(update-product-list) with the product as written', update?.request?.action === 'update-product-list' && short(update.request.add) === short([NEW_PRODUCT]), short(update?.request));
    c('A2A select task: input-required, then canceled by /stop', !!select && select.timeline.includes('input-required') && select.state === 'canceled', `${short(select?.timeline)} -> ${select?.state}`);
    const cart = await ctx.cart();
    c('save info did not touch the basket', cart.length === 0, cartText(cart));
  },
};

const SCENARIOS = [scenarioA, scenarioB, scenarioC];

// ---------- checks every scenario shares ----------

function commonChecks(ctx: Ctx, ev: Evidence | undefined, scenario: Scenario): void {
  const c = ctx.check.bind(ctx);
  const reqs = ctx.requests();
  const policyErrors = reqs.filter((r) => r.error);
  c('scripted model never hit an unexpected conversation state', policyErrors.length === 0, policyErrors.map((r) => short(r.error, 400)).join(' || '));
  c('every model request carried the (fake) API key', reqs.every((r) => r.hadApiKey));
  const leaked = reqs.filter((r) => /CLAUDE\.md|Global Rules/.test(JSON.stringify(r.body)));
  c('no developer CLAUDE.md content reached any agent prompt', leaked.length === 0, `${leaked.length} request(s)`);
  c('Telegram: only the configured token and chat were used', ctx.tg.violations.length === 0, ctx.tg.violations.join('; '));
  const bad = ctx.tg.botMessages().filter((t) => /^(Sorry|Setup error|Вибачте|Помилка налаштування|MOCK POLICY ERROR)|Не вдалося/.test(t));
  c('Telegram: no error / lost-message replies', bad.length === 0, bad.map((t) => short(t, 160)).join(' || '));
  const acks = ctx.tg.botMessages().filter((t) => ACK.test(t)).length;
  c('Telegram: "busy" acknowledgements only where the scenario provokes them', acks === scenario.acks, `${acks} ack(s)`);
  const wantModel: Record<string, string> = { cos: 'claude-opus-5-5', explore: 'claude-sonnet-5-5', execute: 'claude-sonnet-5-5', qa: 'claude-sonnet-5-5' };
  const wrongModel = reqs.filter((r) => wantModel[r.agent] && r.model !== wantModel[r.agent]);
  c('every agent ran on its configured model', wrongModel.length === 0, wrongModel.map((r) => `${r.agent}: ${r.model}`).join(', '));

  // Tool surfaces per agent, as the CLI presented them to the model.
  const firstOf = (agent: string) => reqs.find((r) => r.agent === agent);
  const cosTools = toolSet(firstOf('cos'));
  c('COS model sees exactly the 8 cos tools (no browser, no product list)', short(cosTools) === short([...COS_TOOLS].sort()), cosTools.join(','));
  for (const agent of scenario.agents) {
    const tools = toolSet(firstOf(agent));
    const builtins = tools.filter((t) => BUILTINS.includes(t));
    const foreign = tools.filter((t) => t.startsWith('mcp__cos__') || (agent !== 'explore' && t.startsWith('mcp__explore__')));
    let ok = builtins.length === 0 && foreign.length === 0 && tools.includes('StructuredOutput');
    if (agent === 'explore') {
      ok &&= tools.every((t) => ['Skill', 'StructuredOutput', 'mcp__explore__ask_user', 'mcp__explore__update_product_list'].includes(t));
    } else if (agent === 'execute') {
      ok &&= tools.includes('mcp__playwright__browser_evaluate') && !tools.some((t) => t.startsWith('mcp__agent_browser__')) && !tools.includes('Skill');
    } else {
      ok &&= tools.includes('mcp__agent_browser__agent_browser_eval') && !tools.some((t) => t.startsWith('mcp__playwright__')) && !tools.includes('Skill');
    }
    c(`${agent} model sees only its own tools`, ok && tools.length > 0, `${tools.length} tools; builtins: ${builtins.join(',') || 'none'}; foreign: ${foreign.join(',') || 'none'}`);
  }

  // COS ends a turn with "done" (agents/cos/AGENTS.md): the CLI must never have to nudge it for a visible reply.
  const lastUserText = (r: CapturedRequest) =>
    JSON.stringify((r.body.messages as Array<{ role: string }>).filter((m) => m.role === 'user').at(-1) ?? '');
  const cosReqs = reqs.filter((r) => r.agent === 'cos');
  const cosTurns = cosReqs.filter((r) => lastUserText(r).includes('<telegram_message')).length;
  const nudges = cosReqs.filter((r) => lastUserText(r).includes('had no visible output'));
  c('COS turns end without an empty reply (no extra "no visible output" model call)', nudges.length === 0, `${nudges.length} nudge(s) in ${cosTurns} turn(s)`);
  const enforce = reqs.filter((r) => r.agent !== 'cos' && lastUserText(r).includes('[structured-output-enforce]'));
  c('no sub-agent CLI was nudged for a missing StructuredOutput (e.g. after a cancel)', enforce.length === 0, enforce.map((r) => r.agent).join(', '));

  // The user's other tab, open in the browser all along, never reaches a model.
  const tabLeaks = reqs.filter((r) => JSON.stringify(r.body).includes(PRIVATE_TAB_TITLE));
  c("the user's other tab never reached a model prompt", tabLeaks.length === 0, tabLeaks.map((r) => r.agent).join(', '));
  if (scenario.agents.includes('execute')) {
    const hidden = ctx.requests('execute').some((r) => JSON.stringify(r.body).includes('[another tab, hidden]'));
    c('Execute saw the open-tab list with the other tab hidden (redaction reached the model)', hidden);
  }
  if (!ev) return;
  const cosToolEvents = ev.events.filter((e) => e.agent === 'cos' && (e.kind === 'tool_call' || e.kind === 'tool_result'));
  c(
    "COS tool calls carry the order's contextId (the dashboard's order filter shows them)",
    cosToolEvents.length > 0 && cosToolEvents.every((e) => typeof e.contextId === 'string' && e.contextId.length > 0),
    `${cosToolEvents.length} events`,
  );
  const leakedEvents = ev.events.filter((e) => JSON.stringify(e).includes(PRIVATE_TAB_TITLE));
  c("the user's other tab never reached the dashboard", leakedEvents.length === 0, leakedEvents.map((e) => `${e.agent}/${e.kind}`).join(', '));

  // A2A + supervisor + telemetry.
  for (const agent of scenario.agents) {
    const spawns = ev.events.filter((e) => e.agent === 'cos' && e.kind === 'log' && e.data.event === 'spawned' && e.data.subAgent === agent);
    c(`COS supervisor spawned the ${agent} agent once and reused it`, spawns.length === 1, `${spawns.length} spawn(s), ${ev.byAgent(agent).length} task(s)`);
    c(`every ${agent} task could be read back over A2A`, ev.byAgent(agent).length > 0 && ev.byAgent(agent).every((t) => !t.fetchError), ev.byAgent(agent).map((t) => t.fetchError ?? t.state).join(','));
  }
  const kinds = new Set(ev.events.map((e) => e.kind));
  const missingKinds = ['status', 'a2a', 'tool_call', 'tool_result', 'llm', 'run', 'telegram', 'log'].filter((k) => !kinds.has(k));
  c('dashboard hub received every event kind', missingKinds.length === 0, missingKinds.length ? `missing: ${missingKinds.join(',')}` : `${ev.events.length} events`);
  const agentsSeen = new Set(ev.events.map((e) => e.agent));
  c('dashboard hub has events from COS and every used sub-agent', ['cos', ...scenario.agents].every((a) => agentsSeen.has(a)), [...agentsSeen].join(','));
  const errors = ev.events.filter((e) => e.kind === 'error');
  c('no error events', errors.length === 0, errors.map((e) => `${e.agent}: ${short(e.data.message, 200)}`).join(' || '));
  const used = ['cos', ...scenario.agents];
  const board = ev.board.filter((a) => used.includes(a.agent));
  c(
    'dashboard board: every used agent is idle, made tool calls, has a cost and no errors',
    board.length === used.length && board.every((a) => a.state === 'idle' && a.toolCalls > 0 && a.costUsd > 0 && a.errors === 0),
    board.map((a) => `${a.agent}=${a.state}/${a.toolCalls} calls/$${a.costUsd.toFixed(3)}`).join(', '),
  );
  const boardMismatch = ev.tasks.filter((t) => ev.boardTasks.find((b) => b.taskId === t.taskId)?.state !== t.state);
  c('dashboard task list matches the A2A task states', boardMismatch.length === 0, boardMismatch.map((t) => `${t.agent} ${t.taskId.slice(0, 8)}: board ${ev.boardTasks.find((b) => b.taskId === t.taskId)?.state} vs ${t.state}`).join(', '));
  const tgEvents = ev.events.filter((e) => e.kind === 'telegram');
  c('Telegram transcript mirrored to the dashboard', tgEvents.some((e) => e.data.direction === 'in') && tgEvents.some((e) => e.data.direction === 'out'));
  for (const agent of scenario.agents.filter((a) => a !== 'explore')) {
    const evals = ev.events.filter((e) => e.agent === agent && e.kind === 'tool_call' && /browser_evaluate|agent_browser_eval/.test(String(e.data.tool)));
    const rewritten = evals.filter((e) => e.data.rewritten === true);
    c(`${agent}: the guard injected the shop helper into page scripts (eval rewriting)`, evals.length > 0 && rewritten.length === evals.filter((e) => !e.data.denied).length, `${rewritten.length}/${evals.length} eval calls rewritten`);
  }
  if (scenario.agents.includes('qa')) {
    const probes = ev.events.filter((e) => e.agent === 'qa' && e.kind === 'tool_call' && String(e.data.input).includes('setQty'));
    c('QA read-only guard denied every basket-write attempt', probes.length > 0 && probes.every((e) => typeof e.data.denied === 'string'), probes.map((e) => short(e.data.denied, 100)).join(' | '));
    const qaCalls = modelCalls(reqs, 'qa');
    c('QA opened the basket via the top-right cart icon', qaCalls.includes('mcp__agent_browser__agent_browser_click'));
  }
  if (scenario.agents.includes('execute')) {
    const execCalls = modelCalls(reqs, 'execute');
    const tabActions = reqs.filter((r) => r.agent === 'execute' && r.reply?.kind === 'tool_use' && r.reply.name === 'mcp__playwright__browser_tabs').map((r) => (r.reply as { input: { action?: string } }).input.action);
    c(
      'Execute worked in its own Playwright tab (opened first, never closed or switched)',
      execCalls[0] === 'mcp__playwright__browser_tabs' && execCalls.includes('mcp__playwright__browser_evaluate') && tabActions.every((a) => a === 'new'),
      `${execCalls.slice(0, 4).join(',')}; tab actions: ${tabActions.join(',')}`,
    );
  }
}

function otlpChecks(scenario: string, otlp: OtlpCollector, ev: Evidence | undefined): void {
  const c = (label: string, ok: boolean, detail?: string) => check(scenario, label, ok, detail);
  const services = new Set(otlp.spans.map((s) => s.service));
  c(
    'OTLP traces received (ClawMetry stand-in)',
    otlp.spans.length > 0 && otlp.rejected === 0,
    `${otlp.spans.length} spans from ${[...services].join(',')}${otlp.rejected ? `; ${otlp.rejected} rejected: ${otlp.rejectedSamples.join(' || ')}` : ''}`,
  );
  if (!ev) return;
  const sends = otlp.spans.filter((s) => s.service === 'poo-cos' && s.name.startsWith('a2a.send '));
  for (const task of ev.tasks) {
    const invoke = otlp.spans.find((s) => s.name === `invoke_agent ${task.agent}` && s.attributes['a2a.task_id'] === task.taskId);
    const parent = invoke && sends.find((s) => s.spanId === invoke.parentSpanId);
    const tools = invoke ? otlp.spans.filter((s) => s.traceId === invoke.traceId && s.name.startsWith('execute_tool ')).length : 0;
    c(
      `trace: ${task.agent} task ${task.taskId.slice(0, 8)} is a child of COS's a2a.send span (same trace)`,
      !!invoke && !!parent && parent.traceId === invoke.traceId,
      invoke ? `${tools} execute_tool spans in the trace` : 'no invoke_agent span',
    );
    if (task.timeline.includes('input-required') && task.userTexts.length > 1) {
      const exchanges = sends.filter((s) => s.attributes['a2a.task_id'] === task.taskId);
      c(
        `trace: the answer to ${task.agent} task ${task.taskId.slice(0, 8)} joined the task's trace`,
        exchanges.length >= 2 && exchanges.every((s) => s.traceId === invoke?.traceId) && exchanges.some((s) => s.attributes['a2a.kind'] === 'answer'),
        `${exchanges.length} a2a.send spans: ${exchanges.map((s) => s.attributes['a2a.kind']).join(',')}`,
      );
    }
  }
}

// ---------- main ----------

async function preflight(): Promise<void> {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 24) throw new Error(`Node ${process.versions.node}: the project needs Node >= 24.16`);
  const res = await fetch(SHOP_BASE, { method: 'HEAD', signal: AbortSignal.timeout(15_000) }).catch((err: unknown) => {
    throw new Error(`the live shop ${SHOP_BASE} is not reachable: ${err instanceof Error ? err.message : String(err)}`);
  });
  if (!res.ok) throw new Error(`the live shop answered HTTP ${res.status}`);
}

async function makeRepoCopy(dst: string): Promise<void> {
  await rm(dst, { recursive: true, force: true });
  await mkdir(dst, { recursive: true });
  for (const entry of ['src', 'agents', 'package.json', 'tsconfig.json']) {
    await cp(path.join(REPO, entry), path.join(dst, entry), { recursive: true, filter: (src) => !src.endsWith('.DS_Store') });
  }
  await symlink(path.join(REPO, 'node_modules'), path.join(dst, 'node_modules'), 'dir');
}

function systemEnv(o: { ports: Ports; runtimeDir: string; home: string; mockUrl: string; tgUrl: string; otlpUrl: string }): Record<string, string> {
  const user = os.userInfo().username;
  // Playwright MCP needs a short TMPDIR for its sockets.
  const tmp = os.tmpdir().length <= 64 ? os.tmpdir() : '/tmp';
  return {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: o.home,
    USER: user,
    LOGNAME: user,
    LANG: 'en_US.UTF-8',
    TMPDIR: tmp,
    ANTHROPIC_API_KEY: FAKE_API_KEY,
    ANTHROPIC_BASE_URL: o.mockUrl,
    TELEGRAM_BOT_TOKEN: TG_TOKEN,
    TELEGRAM_ALLOWED_USER_ID: String(TG_USER),
    TELEGRAM_API_ROOT: o.tgUrl,
    A2A_HOST: '127.0.0.1',
    EXPLORE_PORT: String(o.ports.explore),
    EXECUTE_PORT: String(o.ports.execute),
    QA_PORT: String(o.ports.qa),
    SUBAGENT_TIMEOUT_MS: String(8 * 60_000),
    BROWSER_MODE: 'cdp',
    BROWSER_CDP_URL: `http://127.0.0.1:${o.ports.chrome}`,
    EXECUTE_BROWSER_MCP: 'playwright',
    QA_BROWSER_MCP: 'agent-browser',
    DEFAULT_SHOP: 'karashynyard',
    DASHBOARD_HOST: '127.0.0.1',
    DASHBOARD_PORT: String(o.ports.hub),
    DASHBOARD_ENABLED: '1',
    OTEL_EXPORTER_OTLP_ENDPOINT: o.otlpUrl,
    CLAWMETRY_URL: o.otlpUrl,
    LOG_LEVEL: 'info',
    RUNTIME_DIR: o.runtimeDir,
  };
}

const cleanups: Array<() => Promise<unknown>> = [];
let cleaning = false;
async function cleanupAll(): Promise<void> {
  if (cleaning) return;
  cleaning = true;
  for (const fn of cleanups.reverse()) await fn().catch(() => undefined);
}
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    log(`${sig}: cleaning up`);
    void cleanupAll().then(() => process.exit(130));
  });
}

async function runScenario(
  scenario: Scenario,
  shared: { work: string; repoDir: string; mock: MockAnthropic; tg: FakeTelegram; otlp: OtlpCollector },
): Promise<Record<string, unknown>> {
  const id = scenario.id;
  log(`=== scenario ${id}: ${scenario.title}`);
  const dir = path.join(shared.work, `scenario-${id}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(path.join(dir, 'home'), { recursive: true });
  const from = Number(process.env.E2E_PORT_FROM ?? 9400);
  const to = Number(process.env.E2E_PORT_TO ?? 9599);
  const [chromePort, explore, execute, qa, hub] = (await pickPorts(5, from, to)) as [number, number, number, number, number];
  const ports: Ports = { chrome: chromePort, explore, execute, qa, hub };
  shared.tg.reset();
  shared.otlp.reset();
  const mockFrom = shared.mock.requests.length;

  const chrome = await ThrowawayChrome.start({
    port: ports.chrome,
    profileDir: path.join(dir, 'chrome-profile'),
    logFile: path.join(dir, 'chrome.log'),
    ...(process.env.CHROME_PATH ? { chromePath: process.env.CHROME_PATH } : {}),
  });
  const stopChrome = () => chrome.stop();
  cleanups.push(stopChrome);
  log(`throwaway ${await chrome.version()} on :${ports.chrome}; ports explore ${explore}, execute ${execute}, qa ${qa}, hub ${hub}`);
  // Stays open: the agents attach to a browser that has a tab of "the user".
  const opened = await fetch(`${chrome.cdpUrl}/json/new?${encodeURI(PRIVATE_TAB_URL)}`, { method: 'PUT' });
  if (!opened.ok) throw new Error(`could not open the private tab: HTTP ${opened.status}`);

  const hubUrl = `http://127.0.0.1:${ports.hub}`;
  const ctx: Ctx = {
    id,
    dir,
    repoDir: shared.repoDir,
    ports,
    tg: shared.tg,
    mock: shared.mock,
    mockFrom,
    chrome,
    hubUrl,
    check: (label, ok, detail) => check(id, label, ok, detail),
    say(text) {
      const index = shared.tg.transcript.length;
      log(`user -> ${JSON.stringify(text)}`);
      shared.tg.sendUser(text);
      return index;
    },
    async waitBot(pred, label, fromIndex, timeoutMs = STEP_MS) {
      // Fail fast when the scripted model hit a state it does not expect: the flow cannot recover.
      const abortIf = () => {
        const err = shared.mock.requests.slice(mockFrom).find((r) => r.error);
        return err ? `scripted model error: ${short(err.error?.split('\n')[0], 200)}` : undefined;
      };
      const { text } = await shared.tg.waitForBot(pred, { from: fromIndex, timeoutMs, label, abortIf });
      log(`bot  <- ${JSON.stringify(text.length > 140 ? `${text.slice(0, 140)}…` : text)}`);
      return text;
    },
    requests: (agent) => shared.mock.requests.slice(mockFrom).filter((r) => !agent || r.agent === agent),
    async waitHub(query, label, timeoutMs = STEP_MS) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const res = await fetch(`${hubUrl}/api/events?limit=1&${query}`, { signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
        if (res?.ok && ((await res.json()) as { events: unknown[] }).events.length > 0) return;
        if (Date.now() > deadline) throw new Error(`timed out waiting for the dashboard to show ${label}`);
        await sleep(200);
      }
    },
    async evidence() {
      await sleep(1_500); // telemetry is batched every 250 ms per process: let the last events land
      const events = await hubEvents(hubUrl);
      const tasks = await collectTasks(events, ports);
      const board = ((await (await fetch(`${hubUrl}/api/agents`)).json()) as { agents: BoardAgent[] }).agents;
      const boardTasks = ((await (await fetch(`${hubUrl}/api/tasks`)).json()) as { tasks: Evidence['boardTasks'] }).tasks;
      return { events, tasks, board, boardTasks, byAgent: (agent) => tasks.filter((t) => t.agent === agent) };
    },
    cart: async () => (await chrome.readCart(SHOP_ORIGIN)).lines,
  };

  let system: RunningSystem | undefined;
  let stopSystem: (() => Promise<unknown>) | undefined;
  let evidence: Evidence | undefined;
  let stop: StopReport | undefined;
  let failure: string | undefined;
  try {
    system = await RunningSystem.start({
      repoDir: shared.repoDir,
      env: systemEnv({
        ports,
        runtimeDir: path.join(dir, 'runtime'),
        home: path.join(dir, 'home'),
        mockUrl: shared.mock.url,
        tgUrl: shared.tg.url,
        otlpUrl: shared.otlp.url,
      }),
      logFile: path.join(dir, 'launcher.log'),
    });
    const sys = system;
    stopSystem = async () => {
      const r = await sys.stop(); // interrupted run: still report what the graceful stop left behind
      log(`system stopped (code ${r.exitCode}, ${r.stopMs} ms); leftovers: ${[...r.leftovers, ...r.agentBrowserLeftovers].join(' || ') || 'none'}`);
    };
    cleanups.push(stopSystem);
    let polling = false;
    void shared.tg.polling().then(() => (polling = true));
    const deadline = Date.now() + 90_000;
    while (!polling) {
      if (sys.exited) throw new Error(`the launcher exited during startup; see ${sys.logFile}`);
      if (Date.now() > deadline) throw new Error('COS did not start Telegram polling within 90 s');
      await sleep(200);
    }
    log(`system up (launcher pid ${sys.pid}); COS is polling the fake Bot API`);
    await scenario.run(ctx);
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
    check(id, 'scenario flow completed', false, failure);
  }
  try {
    evidence = await ctx.evidence();
  } catch (err) {
    check(id, 'evidence collected from the hub and the A2A agents', false, err instanceof Error ? err.message : String(err));
  }
  commonChecks(ctx, evidence, scenario);
  if (system) {
    log('stopping the system (SIGTERM to the launcher)');
    stop = await system.stop();
    if (stopSystem) cleanups.splice(cleanups.indexOf(stopSystem), 1);
    check(id, 'graceful shutdown: launcher exited 0 within 15 s', stop.exitCode === 0 && stop.stopMs < 15_000, `code ${stop.exitCode} signal ${stop.signal} in ${stop.stopMs} ms`);
    check(id, 'no process of the run outlived the shutdown', stop.leftovers.length === 0, stop.leftovers.join(' || '));
    check(id, 'no agent-browser daemon or session file left', stop.agentBrowserLeftovers.length === 0, stop.agentBrowserLeftovers.join(', '));
    const cmds = stop.commands.join('\n');
    const wanted = scenario.agents.map((a) => `src/agents/${a}/main.ts`);
    check(id, 'real process tree: launcher -> hub + COS -> sub-agents -> Claude Code CLI -> browser MCPs', [
      'src/observability/hub/server.ts',
      'src/agents/cos/main.ts',
      ...wanted,
    ].every((w) => cmds.includes(w)) && (!scenario.agents.includes('execute') || cmds.includes('@playwright/mcp')) && (!scenario.agents.includes('qa') || cmds.includes('agent-browser')), `${stop.processCount} processes`);
    await sleep(300); // last OTLP batches
  }
  otlpChecks(id, shared.otlp, evidence);
  await chrome.stop();
  cleanups.splice(cleanups.indexOf(stopChrome), 1);

  const reqs = shared.mock.requests.slice(mockFrom);
  const summary = {
    scenario: id,
    title: scenario.title,
    failure,
    ports,
    transcript: shared.tg.transcript.map((l) => ({ ...l })),
    tasks: evidence?.tasks,
    modelCalls: Object.fromEntries(['cos', 'explore', 'execute', 'qa'].map((a) => [a, modelCalls(reqs, a)])),
    modelRequests: reqs.length,
    toolSurfaces: Object.fromEntries(['cos', 'explore', 'execute', 'qa'].map((a) => [a, toolSet(reqs.find((r) => r.agent === a))])),
    hubEvents: evidence?.events.length,
    otlpSpans: shared.otlp.spans.length,
    stop,
  };
  await writeFile(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
  await writeFile(
    path.join(dir, 'model-requests.jsonl'),
    reqs.map((r) => JSON.stringify({ seq: r.seq, at: r.at, agent: r.agent, reply: r.reply, error: r.error, lastMessages: (r.body.messages as unknown[]).slice(-2) })).join('\n'),
  );
  if (evidence) await writeFile(path.join(dir, 'hub-events.json'), JSON.stringify(evidence.events, null, 1));
  return summary;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let only = process.env.E2E_ONLY ?? '';
  args.forEach((a, i) => {
    if (a === '--only') only = args[i + 1] ?? '';
    else if (a.startsWith('--only=')) only = a.slice('--only='.length);
  });
  const wanted = only ? only.split(',').map((s) => s.trim().toUpperCase()) : SCENARIOS.map((s) => s.id);
  const scenarios = SCENARIOS.filter((s) => wanted.includes(s.id));

  await preflight();
  const work = process.env.E2E_WORK_DIR ? path.resolve(process.env.E2E_WORK_DIR) : await mkdtemp(path.join(os.tmpdir(), 'poo-e2e-'));
  await mkdir(work, { recursive: true });
  const repoDir = path.join(work, 'repo');
  await makeRepoCopy(repoDir);
  const realSkill = path.join(REPO, SKILL_REL);
  const realSkillHash = await sha256(realSkill);
  log(`work dir ${work}; repo copy ${repoDir}`);

  const mock = await startMockAnthropic(scriptedPolicy);
  const tg = await startFakeTelegram({ token: TG_TOKEN, userId: TG_USER });
  const otlp = await startOtlpCollector();
  cleanups.push(() => mock.close(), () => tg.close(), () => otlp.close());
  log(`mock Anthropic API ${mock.url}; fake Bot API ${tg.url}; OTLP receiver ${otlp.url}`);

  const summaries: Record<string, unknown>[] = [];
  for (const scenario of scenarios) summaries.push(await runScenario(scenario, { work, repoDir, mock, tg, otlp }));

  check('*', 'the real SKILL.md in the repository is unchanged', (await sha256(realSkill)) === realSkillHash);
  await cleanupAll();
  if (process.env.E2E_KEEP !== '1') await rm(repoDir, { recursive: true, force: true });

  const failed = checks.filter((c) => !c.ok);
  const report = { passed: failed.length === 0, durationS: Math.round((Date.now() - t0) / 1000), checks, notes, scenarios: summaries };
  await writeFile(path.join(work, 'report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(
    `\n${failed.length === 0 ? 'E2E OK' : 'E2E FAILED'}: ${checks.length - failed.length}/${checks.length} checks passed in ${report.durationS} s` +
      `${failed.length ? `\nFailed:\n${failed.map((c) => `  [${c.scenario}] ${c.label}${c.detail ? ` (${c.detail})` : ''}`).join('\n')}` : ''}` +
      `${notes.length ? `\nNotes (not failures):\n${notes.map((n) => `  [${n.scenario}] ${n.text}`).join('\n')}` : ''}` +
      `\nReport: ${path.join(work, 'report.json')}\n`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch(async (err) => {
  process.stderr.write(`e2e harness failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  await cleanupAll();
  process.exit(2);
});
