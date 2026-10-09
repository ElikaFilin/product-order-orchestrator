/**
 * `pnpm run doctor`: checks everything the system needs and prints how to fix what is missing.
 * (`run` is required: a bare `pnpm doctor` is pnpm's own built-in command.)
 * Exit code 1 when a required check fails. Secrets are never printed.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { defaultSkillFile } from '../agents/explore/product-list.js';
import { PLAYWRIGHT_EXTENSION_URL } from '../browser/chrome.js';
import { browserConnection, checkBrowser } from '../browser/connection.js';
import { SUB_AGENTS, subAgentSpec } from '../config/agents.js';
import { env, ROOT_DIR } from '../config/env.js';
import { fetchAgentCard } from '../shared/a2a.js';
import { errorMessage } from '../shared/logger.js';

const MIN_NODE = [24, 16] as const;
const CHROME_BUNDLE_ID = 'com.google.chrome';
const SKILL_FILE = defaultSkillFile();

const exec = promisify(execFile);
const require = createRequire(import.meta.url);

interface Result {
  ok: boolean;
  detail: string;
  hint?: string;
  /** The check did not apply (printed with "-"). */
  skipped?: boolean;
}

interface Check {
  name: string;
  /** A failing optional check is a warning and does not change the exit code. */
  required: boolean;
  run(): Promise<Result> | Result;
}

const pass = (detail: string): Result => ({ ok: true, detail });
const fail = (detail: string, hint?: string): Result => ({ ok: false, detail, hint });
const skip = (detail: string): Result => ({ ok: true, detail, skipped: true });

async function getJson(url: string, init: RequestInit = {}, timeoutMs = 3_000): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON; keep the text
  }
  return { status: res.status, body };
}

// ---------- individual checks ----------

function checkNode(): Result {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  const ok = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  return ok
    ? pass(`Node.js ${process.versions.node}`)
    : fail(`Node.js ${process.versions.node}, needs >= ${MIN_NODE.join('.')}`, 'Run `nvm install && nvm use` in the project folder (.nvmrc pins 24.21.0).');
}

async function checkTelegramToken(): Promise<Result> {
  const token = env().TELEGRAM_BOT_TOKEN;
  if (!token) {
    return fail('TELEGRAM_BOT_TOKEN is empty', 'Create a bot with @BotFather in Telegram (/newbot) and put its token into .env.');
  }
  try {
    const { status, body } = await getJson(`https://api.telegram.org/bot${token}/getMe`, {}, 8_000);
    const me = body as { ok?: boolean; result?: { username?: string }; description?: string };
    if (me.ok && me.result?.username) {
      return pass(`bot @${me.result.username}, your chat: https://t.me/${me.result.username}`);
    }
    return fail(
      `Telegram rejected the token (HTTP ${status}${me.description ? `: ${me.description}` : ''})`,
      'Copy the token again from @BotFather (/mybots → your bot → API Token) into .env.',
    );
  } catch (err) {
    // Never echo the request URL: it contains the token.
    return fail(`could not reach api.telegram.org: ${errorMessage(err).replaceAll(token, '<token>')}`, 'Check your internet connection.');
  }
}

/** Bundle id of the macOS default https handler, e.g. "com.google.chrome". */
async function defaultBrowserId(): Promise<string | undefined> {
  if (process.platform !== 'darwin') return undefined;
  const plist = path.join(os.homedir(), 'Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist');
  try {
    const { stdout } = await exec('plutil', ['-convert', 'json', '-o', '-', plist]);
    const handlers = (JSON.parse(stdout) as { LSHandlers?: Array<Record<string, unknown>> }).LSHandlers ?? [];
    const https = handlers.find((h) => h.LSHandlerURLScheme === 'https');
    return typeof https?.LSHandlerRoleAll === 'string' ? https.LSHandlerRoleAll.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

async function checkBrowserReady(): Promise<Result> {
  const check = await checkBrowser(browserConnection(env()));
  return check.ok ? pass(check.detail) : fail(check.detail, check.hint);
}

/** The basket link COS sends opens in the default browser, so in extension mode that must be Chrome. */
async function checkDefaultBrowser(): Promise<Result> {
  if (env().BROWSER_MODE !== 'extension') return skip('BROWSER_MODE=cdp: the basket lives in the `pnpm browser:chrome` window');
  const defaultId = await defaultBrowserId();
  if (defaultId === CHROME_BUNDLE_ID) return pass('Google Chrome');
  return fail(
    `the default browser is ${defaultId ?? 'unknown'}, but the basket is filled in Chrome`,
    'Make Chrome the default browser (Chrome → Settings → Default browser), or open the basket link in Chrome yourself.',
  );
}

function checkExtensionToken(): Result {
  const e = env();
  if (e.BROWSER_MODE !== 'extension') return skip('BROWSER_MODE=cdp');
  if (e.PLAYWRIGHT_MCP_EXTENSION_TOKEN) return pass('set');
  return fail(
    'empty: Chrome asks you to approve the connection on every Execute and QA run',
    `Copy the token the Playwright MCP Bridge extension shows (${PLAYWRIGHT_EXTENSION_URL}) into .env as PLAYWRIGHT_MCP_EXTENSION_TOKEN, then restart.`,
  );
}

async function checkHub(): Promise<Result> {
  const e = env();
  const url = `http://${e.DASHBOARD_HOST}:${e.DASHBOARD_PORT}`;
  if (!e.DASHBOARD_ENABLED) return skip('disabled (DASHBOARD_ENABLED=0)');
  try {
    const { body } = await getJson(`${url}/api/health`);
    const health = body as { ok?: boolean; events?: number };
    if (health.ok) return pass(`${url} (${health.events ?? 0} events today)`);
  } catch {
    // reported below
  }
  if (await portFree(e.DASHBOARD_HOST, e.DASHBOARD_PORT)) {
    return fail(`not running at ${url}`, '`pnpm start` starts it (or `pnpm dashboard` on its own).');
  }
  return fail(
    `port ${e.DASHBOARD_PORT} is in use by another program`,
    `Stop that program (\`lsof -nP -iTCP:${e.DASHBOARD_PORT} -sTCP:LISTEN\` shows it) or set DASHBOARD_PORT in .env.`,
  );
}

async function checkClawMetry(): Promise<Result> {
  const url = env().CLAWMETRY_URL.replace(/\/$/, '');
  try {
    const res = await fetch(`${url}/api/otel-status`, { signal: AbortSignal.timeout(3_000) });
    if (res.ok) return pass(`${url} (OTLP receiver at ${url}/v1/traces)`);
    return fail(`${url} answered HTTP ${res.status}`, 'Is something else using that port? Start ClawMetry with `pnpm clawmetry`.');
  } catch {
    return fail(`not running at ${url}`, 'Optional trace dashboard: `pnpm clawmetry:setup` once, then `pnpm clawmetry`.');
  }
}

function portFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

async function checkAgentPorts(): Promise<Result> {
  const host = env().A2A_HOST;
  const notes: string[] = [];
  const blocked: string[] = [];
  for (const name of SUB_AGENTS) {
    const spec = subAgentSpec(name);
    const card = await fetchAgentCard(spec.baseUrl);
    if (card?.name === spec.title) notes.push(`${name} :${spec.port} running`);
    else if (await portFree(host, spec.port)) notes.push(`${name} :${spec.port} free`);
    else blocked.push(`${name} :${spec.port}`);
  }
  if (blocked.length === 0) return pass(notes.join(', '));
  return fail(
    `in use by another program: ${blocked.join(', ')}`,
    'Stop that program (`lsof -nP -iTCP:<port> -sTCP:LISTEN` shows it) or set EXPLORE_PORT / EXECUTE_PORT / QA_PORT in .env.',
  );
}

function checkSdkBinary(): Result {
  const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  const candidates = process.platform === 'linux' ? [pkg, `${pkg}-musl`] : [pkg];
  try {
    // The SDK resolves its native binary relative to itself (pnpm keeps it next to the SDK, not hoisted).
    const sdkRequire = createRequire(require.resolve('@anthropic-ai/claude-agent-sdk'));
    for (const name of candidates) {
      try {
        const dir = path.dirname(sdkRequire.resolve(`${name}/package.json`));
        const bin = path.join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude');
        if (existsSync(bin)) return pass(`${name} (${path.relative(ROOT_DIR, bin)})`);
      } catch {
        // try the next candidate
      }
    }
  } catch (err) {
    return fail(`@anthropic-ai/claude-agent-sdk is not installed (${errorMessage(err)})`, 'Run `corepack pnpm install`.');
  }
  return fail(`${pkg} is missing`, 'Reinstall without skipping optional dependencies: `corepack pnpm install --force`.');
}

// ---------- runner ----------

function checks(): Check[] {
  const e = env();
  return [
    { name: 'Node.js >= 24.16', required: true, run: checkNode },
    {
      name: '.env file',
      required: true,
      run: () =>
        existsSync(path.join(ROOT_DIR, '.env'))
          ? pass(path.join(ROOT_DIR, '.env'))
          : fail('not found', 'cp .env.example .env, then fill in the values.'),
    },
    {
      name: 'ANTHROPIC_API_KEY',
      required: true,
      run: () =>
        e.ANTHROPIC_API_KEY
          ? pass('set')
          : fail('empty', 'Create a key at https://console.anthropic.com/settings/keys and put it into .env.'),
    },
    { name: 'Telegram bot token', required: true, run: checkTelegramToken },
    {
      name: 'TELEGRAM_ALLOWED_USER_ID',
      required: true,
      run: () =>
        e.TELEGRAM_ALLOWED_USER_ID !== undefined
          ? pass(String(e.TELEGRAM_ALLOWED_USER_ID))
          : fail('empty: the bot runs in setup mode', 'Run `pnpm start`, send /start to your bot, put the id it replies with into .env, restart.'),
    },
    { name: `Browser (${e.BROWSER_MODE})`, required: true, run: checkBrowserReady },
    { name: 'Chrome is the default browser', required: false, run: checkDefaultBrowser },
    { name: 'PLAYWRIGHT_MCP_EXTENSION_TOKEN', required: false, run: checkExtensionToken },
    { name: 'Agent ports', required: true, run: checkAgentPorts },
    { name: 'Agent SDK native binary', required: true, run: checkSdkBinary },
    {
      name: 'Explore skill',
      required: true,
      run: () =>
        existsSync(SKILL_FILE)
          ? pass(path.relative(ROOT_DIR, SKILL_FILE))
          : fail(`${path.relative(ROOT_DIR, SKILL_FILE)} is missing`, 'Restore it from git: `git checkout -- agents/explore`.'),
    },
    { name: 'Dashboard hub', required: false, run: checkHub },
    { name: 'ClawMetry', required: false, run: checkClawMetry },
  ];
}

async function main(): Promise<void> {
  process.stdout.write('Product Order Orchestrator — doctor\n\n');
  let failed = 0;
  let warnings = 0;
  for (const check of checks()) {
    let result: Result;
    try {
      result = await check.run();
    } catch (err) {
      result = fail(`check crashed: ${errorMessage(err)}`);
    }
    const mark = result.skipped ? '-' : result.ok ? '✓' : check.required ? '✗' : '!';
    if (!result.ok) {
      if (check.required) failed += 1;
      else warnings += 1;
    }
    process.stdout.write(`${mark} ${check.name}: ${result.detail}\n`);
    if (!result.ok && result.hint) process.stdout.write(`    fix: ${result.hint}\n`);
  }
  process.stdout.write(
    `\n${failed === 0 ? 'All required checks passed' : `${failed} required check(s) failed`}` +
      `${warnings ? `, ${warnings} warning(s)` : ''}.\n`,
  );
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
  process.stderr.write(`doctor failed: ${errorMessage(err)}\n`);
  process.exit(1);
});
