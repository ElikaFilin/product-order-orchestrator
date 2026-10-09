/**
 * Live smoke test of a shop adapter and the browser guard: `pnpm smoke:shop [shopId]`.
 *
 * Starts a THROWAWAY headless Chrome (fresh temp profile, never the user's browser), spawns both browser
 * MCP servers exactly as browserToolset() configures them and sends every tool input through
 * createBrowserGuard(), so the helper injection is exercised end to end. Playwright plays Execute
 * (setQty add / increase / decrease / remove), agent-browser plays QA (cart icon -> cart window ->
 * readModal + readCart); then the roles swap (Playwright cart-icon click, agent-browser setQty cleanup),
 * since either server can be configured for either agent. The basket only exists in the throwaway
 * profile and the order form is never touched. Exits 1 on any mismatch, so maintainers can run it to
 * detect site drift. Optional env: CHROME_PATH (Chrome binary), SMOKE_PROFILE_PARENT (temp profile parent).
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { checkCdp } from '../browser/cdp.js';
import { createBrowserGuard } from '../browser/guard.js';
import { browserToolset, toolResultValue, type BrowserMcpKind, type BrowserToolset } from '../browser/mcp.js';
import { env, runtimeDir } from '../config/env.js';
import { preview, Telemetry } from '../observability/telemetry.js';
import type { GuardDecision, ToolGuard } from '../shared/claude.js';
import { createLogger, errorMessage } from '../shared/logger.js';
import { getShop, type ShopAdapter } from '../shops/index.js';

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
/** Parent of the throwaway Chrome profile. Not TMPDIR itself: Playwright MCP needs a short TMPDIR for its sockets. */
const PROFILE_PARENT = process.env.SMOKE_PROFILE_PARENT ?? tmpdir();

/** Products the smoke test drives, per shop: exact site names [A, B, C]. */
const PROBES: Record<string, [string, string, string]> = {
  karashynyard: ['Філе зі стегна індички, 1 кг', 'Печінка курочки, 500 г', 'Горіхова паста з фунндуком 350 г'],
};

// Shapes of the in-page helper (window.__poo) results.
interface PageStatus { ready: boolean; url: string; cartLines: number; units: number; total: number }
interface FindResult { found: boolean; name?: string; price?: number; sku?: string; selector?: string; candidates?: string[] }
interface CartView { lines: Array<{ name: string; qty: number; unitPrice: number; amount: number; sku: string }>; units: number; total: number }
interface ModalView { open: boolean; lines: Array<{ name: string; qty: number; amount: number | null }>; total: number | null }
interface SetQtyResult { status: 'ok' | 'not_found' | 'failed'; name: string; before: number; after: number; detail?: string }
interface Expected { name: string; qty: number; price: number }

const log = createLogger('shop-smoke');

class Report {
  failures = 0;

  check(label: string, ok: boolean, detail = ''): void {
    if (!ok) this.failures += 1;
    process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}\n`);
  }

  section(title: string): void {
    process.stdout.write(`\n== ${title}\n`);
  }
}

/** One browser MCP server, called the way an agent's PreToolUse guard would let it. */
class BrowserSession {
  private constructor(
    readonly toolset: BrowserToolset,
    private readonly client: Client,
    private readonly guard: ToolGuard,
    private readonly telemetry: Telemetry,
    private readonly stderr: string[],
  ) {}

  static async start(toolset: BrowserToolset, shop: ShopAdapter, telemetry: Telemetry): Promise<BrowserSession> {
    const server = toolset.server as { command: string; args?: string[]; env?: Record<string, string> };
    const transport = new StdioClientTransport({ command: server.command, args: server.args, env: server.env, stderr: 'pipe' });
    const stderr: string[] = [];
    transport.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));
    const client = new Client({ name: 'poo-shop-smoke', version: '0.1.0' });
    await client.connect(transport);
    return new BrowserSession(toolset, client, createBrowserGuard(shop, toolset), telemetry, stderr);
  }

  /** The guard's decision for a call (no tool is called). */
  decide(tool: string, input: Record<string, unknown>): GuardDecision | undefined {
    return this.guard(this.toolset.tool(tool), input);
  }

  /** Call a tool through the guard; returns the parsed result. Throws on a denial or a tool error. */
  async call(tool: string, input: Record<string, unknown>): Promise<unknown> {
    const decision = this.decide(tool, input);
    const event = { tool: this.toolset.tool(tool), input: preview(input) };
    if (decision?.deny) {
      this.telemetry.emit('tool_call', { ...event, denied: decision.deny });
      throw new Error(`guard denied ${tool}: ${decision.deny}`);
    }
    this.telemetry.emit('tool_call', { ...event, rewritten: Boolean(decision?.updatedInput) });
    return this.send(tool, decision?.updatedInput ?? input);
  }

  /**
   * Test scaffolding only, never something an agent may do (the guard denies it): e.g. listing and selecting
   * tabs to bring the right throwaway tab to the front.
   */
  callUnguarded(tool: string, input: Record<string, unknown>): Promise<unknown> {
    return this.send(tool, input);
  }

  private async send(tool: string, input: Record<string, unknown>): Promise<unknown> {
    const started = Date.now();
    const result = await this.client.callTool({ name: tool, arguments: input }, undefined, { timeout: 120_000 });
    const text = Array.isArray(result.content)
      ? result.content.flatMap((c: { type: string; text?: string }) => (c.type === 'text' && c.text ? [c.text] : [])).join('\n')
      : '';
    this.telemetry.emit('tool_result', { tool: this.toolset.tool(tool), ok: !result.isError, durationMs: Date.now() - started, output: preview(text, 500) });
    if (result.isError) throw new Error(`${tool} failed: ${preview(text, 500)}`);
    return toolResultValue(this.toolset.kind, result);
  }

  /** Evaluate an expression in the page (the guard injects the shop helper). */
  eval<T>(expression: string): Promise<T> {
    const input = this.toolset.kind === 'playwright' ? { function: `() => ${expression}` } : { script: expression };
    const evalTool = this.toolset.evalTool.name.slice(`mcp__${this.toolset.serverName}__`.length);
    return this.call(evalTool, input) as Promise<T>;
  }

  stderrTail(): string {
    return this.stderr.join('').slice(-1_500);
  }

  /** Stop the server, then whatever it leaves running (agent-browser's daemon), exactly as Execute/QA do. */
  async close(): Promise<void> {
    await this.client.close().catch(() => undefined);
    await this.toolset.cleanup();
  }
}

interface ThrowawayChrome {
  cdpUrl: string;
  browser: string;
  stop(): Promise<void>;
}

/** Headless Chrome with a fresh temp profile; Chrome picks a free debugging port and writes it to DevToolsActivePort. */
async function startChrome(): Promise<ThrowawayChrome> {
  const profileDir = await mkdtemp(path.join(PROFILE_PARENT, 'poo-smoke-chrome-'));
  const child = spawn(
    CHROME,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,900', // >= 980 px: Tilda shows the floating cart icon at the top right
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  let spawnError: Error | undefined;
  child.once('error', (err) => (spawnError = err));
  const running = () => child.exitCode === null && child.signalCode === null && !spawnError;

  const stop = async () => {
    if (running()) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), sleep(5_000)]);
      if (running()) child.kill('SIGKILL');
    }
    await rm(profileDir, { recursive: true, force: true });
  };

  try {
    for (let i = 0; i < 100; i++) {
      if (!running()) throw new Error(`Chrome exited early: ${spawnError?.message ?? `code ${child.exitCode}`} (${CHROME})`);
      const port = await readFile(path.join(profileDir, 'DevToolsActivePort'), 'utf8').then((s) => s.split('\n')[0], () => '');
      if (port) {
        const cdpUrl = `http://127.0.0.1:${port}`;
        const status = await checkCdp(cdpUrl);
        if (status.ok) return { cdpUrl, browser: status.browser ?? 'unknown', stop };
      }
      await sleep(100);
    }
    throw new Error('Chrome did not open its debugging port within 10 s');
  } catch (err) {
    await stop();
    throw err;
  }
}

async function waitReady(session: BrowserSession): Promise<PageStatus> {
  let last: unknown;
  for (let i = 0; i < 30; i++) {
    try {
      const status = await session.eval<PageStatus>('window.__poo.status()');
      if (status.ready) return status;
      last = status;
    } catch (err) {
      last = errorMessage(err); // the page may still be navigating
    }
    await sleep(1_000);
  }
  throw new Error(`shop page not ready after 30 s: ${preview(last, 300)}`);
}

function sameLines(actual: Array<{ name: string; qty: number; amount: number | null }>, expected: Expected[]): string {
  const problems: string[] = [];
  for (const e of expected) {
    const line = actual.find((l) => l.name === e.name);
    if (!line) problems.push(`missing ${e.name}`);
    else if (line.qty !== e.qty || line.amount !== e.qty * e.price) {
      problems.push(`${e.name}: qty ${line.qty}/${e.qty}, amount ${line.amount}/${e.qty * e.price}`);
    }
  }
  for (const l of actual) if (!expected.some((e) => e.name === l.name)) problems.push(`extra ${l.name}`);
  return problems.join('; ');
}

const total = (expected: Expected[]) => expected.reduce((sum, e) => sum + e.qty * e.price, 0);

/** Run after the Execute flow: the Playwright guard allows nothing but opening a tab until its run has one. */
function checkGuard(report: Report, exe: BrowserSession, qa: BrowserSession, shop: ShopAdapter): void {
  report.section('guard');
  const denied = (d: GuardDecision | undefined) => Boolean(d?.deny);
  const fresh = createBrowserGuard(shop, exe.toolset);
  report.check(
    'denies Playwright tools before the run opened its own tab',
    denied(fresh(exe.toolset.tool('browser_evaluate'), { function: '() => window.__poo.status()' })),
  );
  for (const action of ['list', 'select', 'close']) {
    report.check(`denies browser_tabs ${action} (the user's tabs)`, denied(exe.decide('browser_tabs', { action, index: 0 })));
  }
  report.check('denies a page script that is not one helper call', denied(exe.decide('browser_evaluate', { function: '() => document.title' })));
  report.check(
    'denies a fetch to the fallback order endpoint',
    denied(qa.decide('agent_browser_eval', { script: 'fetch("https://forms2.tildacdn.com/procces/", { method: "POST" })' })),
  );
  report.check('denies navigation to another origin (Playwright)', denied(exe.decide('browser_navigate', { url: 'https://example.com/' })));
  report.check('denies navigation to another origin (agent-browser)', denied(qa.decide('agent_browser_open', { url: 'https://example.com/' })));
  report.check('allows navigation to the cart URL', !denied(exe.decide('browser_navigate', { url: shop.cartUrl })));
  report.check(
    'denies an eval mentioning "Відправити замовлення"',
    denied(exe.decide('browser_evaluate', { function: '() => [...document.querySelectorAll("button")].find((b) => b.textContent.includes("Відправити замовлення"))?.click()' })),
  );
  report.check('denies requestSubmit() in agent-browser eval', denied(qa.decide('agent_browser_eval', { script: 'document.forms[0].requestSubmit()' })));
  report.check('denies a click on the order form', denied(exe.decide('browser_click', { target: '.t706__orderform button', element: 'order button' })));
  report.check('denies browser_run_code_unsafe', denied(exe.decide('browser_run_code_unsafe', { code: 'async (page) => page.title()' })));
  report.check('denies navigation from page scripts', denied(exe.decide('browser_evaluate', { function: '() => { location.href = "https://example.com/" }' })));
  report.check('lets helper calls through', !denied(exe.decide('browser_evaluate', { function: '() => window.__poo.setQty("X", 2)' })));
}

/** Execute role (Playwright MCP): returns the basket it leaves behind. */
async function executeFlow(report: Report, exe: BrowserSession, shop: ShopAdapter, [a, b, c]: [string, string, string]): Promise<Expected[]> {
  report.section(`execute via ${exe.toolset.kind}`);
  await exe.call('browser_tabs', { action: 'new', url: shop.baseUrl });
  const status = await waitReady(exe);
  report.check('page ready, helper injected', status.ready, status.url);
  report.check('fresh profile starts with an empty basket', status.cartLines === 0, `${status.cartLines} lines`);

  const prices = new Map<string, number>();
  for (const name of [a, b, c]) {
    const found = await exe.eval<FindResult>(`window.__poo.find(${JSON.stringify(name)})`);
    if (found.found && found.price) prices.set(name, found.price);
    report.check(
      `find ${name}`,
      found.found && found.name === name && (found.price ?? 0) > 0 && Boolean(found.sku),
      found.found ? `${found.price} UAH, sku ${found.sku}, ${found.selector}` : `closest: ${found.candidates?.join(' | ')}`,
    );
  }
  const missing = await exe.eval<FindResult>('window.__poo.find("Фарш з філе зі стегна індички, 2 кг")');
  report.check('find returns closest names for an unknown product', !missing.found && (missing.candidates?.length ?? 0) > 0, missing.candidates?.slice(0, 2).join(' | '));

  const ops: Array<[string, number, string]> = [
    [a, 2, 'add'],
    [b, 1, 'add'],
    [a, 3, 'increase'],
    [a, 1, 'decrease'],
    [b, 0, 'remove'],
    [c, 2, 'add'],
  ];
  for (const [name, qty, kind] of ops) {
    const started = Date.now();
    const r = await exe.eval<SetQtyResult>(`window.__poo.setQty(${JSON.stringify(name)}, ${qty})`);
    report.check(
      `setQty ${kind}: ${name} -> ${qty}`,
      r.status === 'ok' && r.after === qty,
      `${r.status}, ${r.before} -> ${r.after}, ${Date.now() - started} ms${r.detail ? `, ${r.detail}` : ''}`,
    );
  }

  const expected: Expected[] = [
    { name: a, qty: 1, price: prices.get(a) ?? NaN },
    { name: c, qty: 2, price: prices.get(c) ?? NaN },
  ];
  const cart = await exe.eval<CartView>('window.__poo.readCart()');
  const problems = sameLines(cart.lines, expected);
  report.check('readCart matches', !problems, problems || `${cart.lines.length} lines, ${cart.units} units, ${cart.total} UAH`);
  report.check('readCart total', cart.total === total(expected), `${cart.total} / ${total(expected)} UAH`);
  return expected;
}

/** Click the cart icon like the user (QA playbook order); returns which way opened the cart window. */
async function openCartLikeUser(qa: BrowserSession, shop: ShopAdapter): Promise<string> {
  const attempts: Array<[string, () => Promise<unknown>]> = [
    ['cart icon', () => qa.call('agent_browser_click', { selector: '.t706__carticon-wrapper' })],
    ['header cart icon', () => qa.call('agent_browser_click', { selector: 'a.t-menuwidgeticons__link_cart' })],
    ['#opencart page load', async () => {
      await qa.call('agent_browser_open', { url: 'about:blank' });
      await qa.call('agent_browser_open', { url: shop.cartUrl });
    }],
  ];
  for (const [label, attempt] of attempts) {
    try {
      await attempt();
      await qa.call('agent_browser_wait_for_selector', { selector: '.t706__cartwin.t706__cartwin_showed', waitTimeoutMs: 10_000 });
      return label;
    } catch (err) {
      log.debug({ label, err: errorMessage(err) }, 'cart did not open this way');
    }
  }
  throw new Error('the cart window did not open (cart icon, header icon, #opencart)');
}

/** QA role (agent-browser MCP), in its own tab of the same profile. */
async function qaFlow(report: Report, qa: BrowserSession, shop: ShopAdapter, expected: Expected[]): Promise<void> {
  report.section(`qa via ${qa.toolset.kind}`);
  await qa.call('agent_browser_open', { url: shop.baseUrl });
  const status = await waitReady(qa);
  report.check('own tab ready, sees the same basket', status.cartLines === expected.length, `${status.cartLines} lines, ${status.total} UAH`);

  const how = await openCartLikeUser(qa, shop);
  report.check('cart window opened by clicking the top-right cart icon', how === 'cart icon', how);

  const visible = String(await qa.call('agent_browser_get_text', { selector: '.t706__cartwin-products' }));
  const unseen = expected.filter((e) => !visible.includes(e.name)).map((e) => e.name);
  report.check('cart window text lists every line', unseen.length === 0, unseen.length ? `not shown: ${unseen.join(', ')}` : preview(visible.replace(/\s+/g, ' '), 160));

  const modal = await qa.eval<ModalView>('window.__poo.readModal()');
  const modalProblems = sameLines(modal.lines, expected);
  report.check('readModal: window open', modal.open);
  report.check('readModal matches', !modalProblems, modalProblems || `${modal.lines.length} lines`);
  report.check('readModal total', modal.total === total(expected), `${modal.total} / ${total(expected)} UAH`);

  const cart = await qa.eval<CartView>('window.__poo.readCart()');
  const cartProblems = sameLines(cart.lines, expected);
  report.check('readCart (QA tab) matches the cart window', !cartProblems && cart.total === modal.total, cartProblems || `${cart.total} UAH`);
}

/** The QA click path with Playwright MCP (for QA_BROWSER_MCP=playwright), in the Execute tab. */
async function playwrightCartIcon(report: Report, exe: BrowserSession, expected: Expected[]): Promise<void> {
  report.section(`qa click path via ${exe.toolset.kind}`);
  // agent-browser's tab is in front now, and Playwright's click waits for animation frames that a hidden
  // tab never renders: bring our own tab (the current one) to the front first.
  const tabs = String(await exe.callUnguarded('browser_tabs', { action: 'list' }));
  const current = tabs.match(/^- (\d+): \(current\)/m);
  if (current) await exe.callUnguarded('browser_tabs', { action: 'select', index: Number(current[1]) });
  await exe.call('browser_click', { target: '.t706__carticon-wrapper', element: 'cart icon' });
  let modal = await exe.eval<ModalView>('window.__poo.readModal()');
  for (let i = 0; i < 10 && !modal.open; i++) {
    await sleep(500);
    modal = await exe.eval<ModalView>('window.__poo.readModal()');
  }
  report.check('cart icon click opens the cart window', modal.open);
  const snapshot = String(await exe.call('browser_snapshot', { target: '.t706__cartwin-products' }));
  const unseen = expected.filter((e) => !snapshot.includes(e.name)).map((e) => e.name);
  report.check('cart window snapshot lists every line', unseen.length === 0, unseen.length ? `not shown: ${unseen.join(', ')}` : `${snapshot.length} chars`);
  const problems = sameLines(modal.lines, expected);
  report.check('readModal matches', !problems && modal.total === total(expected), problems || `${modal.total} UAH`);
}

/** Empty the basket through `session` and confirm every tab of the profile sees it empty. */
async function emptyBasket(report: Report, session: BrowserSession, other: BrowserSession, expected: Expected[]): Promise<void> {
  report.section(`cleanup via ${session.toolset.kind}`);
  for (const { name } of expected) {
    const started = Date.now();
    const r = await session.eval<SetQtyResult>(`window.__poo.setQty(${JSON.stringify(name)}, 0)`);
    report.check(
      `setQty remove: ${name} -> 0`,
      r.status === 'ok' && r.after === 0,
      `${r.status}, ${r.before} -> ${r.after}, ${Date.now() - started} ms${r.detail ? `, ${r.detail}` : ''}`,
    );
  }
  for (const s of [session, other]) {
    const cart = await s.eval<CartView>('window.__poo.readCart()');
    report.check(`basket is empty (${s.toolset.kind} tab)`, cart.lines.length === 0, `${cart.lines.length} lines`);
  }
}

async function main(): Promise<void> {
  const shop = getShop(process.argv[2] ?? env().DEFAULT_SHOP);
  const probes = PROBES[shop.id];
  if (!probes) throw new Error(`No smoke-test products configured for shop "${shop.id}" (see PROBES in ${import.meta.filename}).`);

  const report = new Report();
  const telemetry = new Telemetry('shop-smoke');
  const runDir = runtimeDir('runs', `smoke-${shop.id}-${Date.now()}`);
  telemetry.status('busy', `smoke test of ${shop.id}`);
  const chrome = await startChrome();
  process.stdout.write(`shop ${shop.name}; throwaway ${chrome.browser} at ${chrome.cdpUrl}; artifacts ${runDir}\n`);

  const sessions: BrowserSession[] = [];
  // The QA role has every tool the Execute role has, plus the basket-icon click both sessions need here.
  const toolset = (kind: BrowserMcpKind) =>
    browserToolset(kind, {
      role: 'qa',
      connection: { mode: 'cdp', cdpUrl: chrome.cdpUrl },
      outputDir: path.join(runDir, kind),
      blockedOrigins: shop.blockedOrigins,
      session: `smoke-${process.pid}`,
    });
  try {
    const exe = await BrowserSession.start(toolset('playwright'), shop, telemetry);
    sessions.push(exe);
    const qa = await BrowserSession.start(toolset('agent-browser'), shop, telemetry);
    sessions.push(qa);

    const expected = await executeFlow(report, exe, shop, probes);
    checkGuard(report, exe, qa, shop);
    await qaFlow(report, qa, shop, expected);
    await playwrightCartIcon(report, exe, expected);
    await emptyBasket(report, qa, exe, expected);
  } catch (err) {
    report.check('smoke run completed', false, errorMessage(err));
    for (const s of sessions) log.error({ server: s.toolset.serverName, stderr: s.stderrTail() }, 'MCP server stderr');
  } finally {
    for (const s of sessions) await s.close();
    await chrome.stop();
  }

  process.stdout.write(`\n${report.failures === 0 ? 'SMOKE OK' : `SMOKE FAILED: ${report.failures} check(s)`}\n`);
  telemetry.status(report.failures === 0 ? 'idle' : 'error', `smoke test of ${shop.id}: ${report.failures} failure(s)`);
  await telemetry.shutdown();
  process.exitCode = report.failures === 0 ? 0 : 1;
}

main().catch((err) => {
  process.stderr.write(`shop smoke test failed to run: ${errorMessage(err)}\n`);
  process.exit(1);
});
