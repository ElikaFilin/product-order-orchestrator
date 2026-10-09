/**
 * `pnpm start`: runs the dashboard hub and the COS agent as child processes with prefixed output.
 * COS spawns the sub-agents itself (on first use, or up front with SUBAGENTS_PRESTART=1), so the
 * launcher never starts them. Ctrl+C stops everything (COS and its sub-agents first, the hub last, so their
 * final events still reach the board); if a child dies, everything stops with exit 1.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { browserConnection, checkBrowser } from './browser/connection.js';
import { SUB_AGENTS, subAgentSpec } from './config/agents.js';
import { env, ROOT_DIR, runtimeDir } from './config/env.js';
import { AGENT_CARD_PATH } from './shared/a2a.js';
import { errorMessage } from './shared/logger.js';
import { pruneOlderThan } from './shared/retention.js';

const HUB_READY_TIMEOUT_MS = 15_000;
/** COS stops its sub-agents on SIGTERM, which takes a few seconds; then leftovers are killed. */
const STOP_GRACE_MS = 10_000;
const HUB_STOP_GRACE_MS = 4_000;

type ChildName = 'hub' | 'cos';
const children = new Map<ChildName, ChildProcess>();
let stopping = false;

const say = (text: string) => process.stdout.write(`[launcher] ${text}\n`);

function pipeWithPrefix(from: Readable, prefix: string, to: Writable): void {
  createInterface({ input: from, crlfDelay: Infinity }).on('line', (line) => to.write(`${prefix} ${line}\n`));
}

function startChild(name: ChildName, entry: string): void {
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(ROOT_DIR, entry)], {
    cwd: ROOT_DIR,
    env: { ...process.env, POO_LAUNCHED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  pipeWithPrefix(child.stdout, `[${name}]`, process.stdout);
  pipeWithPrefix(child.stderr, `[${name}]`, process.stderr);
  child.on('error', (err) => {
    say(`could not start ${name}: ${err.message}`);
    void shutdown(1);
  });
  child.on('exit', (code, signal) => {
    children.delete(name);
    if (stopping) return;
    say(`${name} exited unexpectedly (${signal ?? `code ${code}`}); stopping everything`);
    void shutdown(1);
  });
  children.set(name, child);
}

async function shutdown(exitCode: number): Promise<never> {
  if (!stopping) {
    stopping = true;
    // COS first (it stops its sub-agents), the hub last. Always SIGTERM: on Ctrl+C the terminal already sent
    // SIGINT to the whole process group, and a second SIGINT would hit a default handler mid-shutdown.
    await stopChild('cos', STOP_GRACE_MS);
    await stopChild('hub', HUB_STOP_GRACE_MS);
  }
  process.exit(exitCode);
}

async function stopChild(name: ChildName, graceMs: number): Promise<void> {
  const child = children.get(name);
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, sleep(graceMs)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

async function hubHealthy(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) });
    return res.ok && ((await res.json()) as { ok?: boolean }).ok === true;
  } catch {
    return false;
  }
}

async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1_500) });
    return true;
  } catch {
    return false;
  }
}

async function ensureHub(hubUrl: string): Promise<void> {
  if (await hubHealthy(hubUrl)) {
    say(`dashboard hub already running at ${hubUrl}; reusing it`);
    return;
  }
  startChild('hub', 'src/observability/hub/server.ts');
  const deadline = Date.now() + HUB_READY_TIMEOUT_MS;
  while (!(await hubHealthy(hubUrl))) {
    if (stopping) return;
    if (Date.now() > deadline) {
      say(`dashboard hub did not become healthy at ${hubUrl} within ${HUB_READY_TIMEOUT_MS / 1000}s`);
      await shutdown(1);
    }
    await sleep(200);
  }
}

async function printSummary(hubUrl: string | undefined): Promise<void> {
  const e = env();
  const [clawmetryUp, browser] = await Promise.all([reachable(e.CLAWMETRY_URL), checkBrowser(browserConnection(e))]);
  const subAgentNote = e.SUBAGENTS_PRESTART ? 'started by COS now' : 'started by COS on first use';
  const lines = [
    '',
    'Product Order Orchestrator (the [cos] lines below show whether COS started)',
    '  Telegram:    open the chat with your bot (`pnpm run doctor` prints its t.me link)',
    `  Dashboard:   ${hubUrl ?? 'disabled (DASHBOARD_ENABLED=0)'}`,
    `  ClawMetry:   ${e.CLAWMETRY_URL}${clawmetryUp ? '' : '  (not reachable: run `pnpm clawmetry` in another terminal)'}`,
    `  Agent cards (${subAgentNote}):`,
    ...SUB_AGENTS.map((name) => `    ${name.padEnd(8)} ${subAgentSpec(name).baseUrl}/${AGENT_CARD_PATH}`),
    browser.ok ? `  Browser:     ${browser.detail}` : `  Browser:     NOT ready: ${browser.detail}.\n               ${browser.hint}`,
    '  Stop with Ctrl+C.',
    '',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function main(): Promise<void> {
  const e = env();
  process.once('SIGINT', () => void shutdown(0));
  process.once('SIGTERM', () => void shutdown(0));

  const pruned = await pruneOlderThan(runtimeDir('runs'), e.RUNTIME_RETENTION_DAYS);
  if (pruned.length) say(`deleted ${pruned.length} browser run folder(s) older than ${e.RUNTIME_RETENTION_DAYS} days`);
  const hubUrl = e.DASHBOARD_ENABLED ? `http://${e.DASHBOARD_HOST}:${e.DASHBOARD_PORT}` : undefined;
  if (hubUrl) await ensureHub(hubUrl);
  if (stopping) return;
  startChild('cos', 'src/agents/cos/main.ts');
  await printSummary(hubUrl);
}

main().catch((err) => {
  say(`failed: ${errorMessage(err)}`);
  void shutdown(1);
});
