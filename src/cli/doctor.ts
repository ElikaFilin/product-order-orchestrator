/**
 * `pnpm run doctor`: checks everything the system needs and prints how to fix what is missing.
 * (`run` is required: a bare `pnpm doctor` is pnpm's own built-in command.)
 * Exit code 1 when a required check fails. Secrets are never printed.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { PLAYWRIGHT_EXTENSION_URL } from '../browser/chrome.js';
import { browserConnection, checkBrowser } from '../browser/connection.js';
import { checkoutDetails, env, ROOT_DIR } from '../config/env.js';
import { errorMessage } from '../core/errors.js';
import { skillFile } from '../core/explore/product-list.js';
import { GATEWAY_PORT, localOpenClaw } from '../openclaw/local.js';
import { bundleIsCurrent, configProblems, installedOpenClawVersion, openclaw, OPENCLAW_VERSION, parseCliJson, PLUGIN_ID, pluginProblems } from './openclaw-checks.js';

const MIN_NODE = [24, 16] as const;
const CHROME_BUNDLE_ID = 'com.google.chrome';
const SKILL_FILE = skillFile(ROOT_DIR);

const exec = promisify(execFile);

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
    `Copy the token the Playwright Extension shows (${PLAYWRIGHT_EXTENSION_URL}) into .env as PLAYWRIGHT_MCP_EXTENSION_TOKEN, then restart.`,
  );
}

function checkOrderFormDetails(): Result {
  try {
    return checkoutDetails() ? pass('set: Execute fills the order form (it never sends it)') : skip('not set: you fill the order form yourself');
  } catch (err) {
    return fail(errorMessage(err), 'Fix the CHECKOUT_* values in .env (see .env.example), then restart.');
  }
}

// ---------- OpenClaw (the project's own, see src/openclaw/local.ts) ----------

function checkOpenclawPackage(): Result {
  const version = installedOpenClawVersion();
  if (!version) return fail('node_modules/openclaw is missing', 'corepack pnpm install');
  return version === OPENCLAW_VERSION ? pass(`OpenClaw ${version}`) : fail(`OpenClaw ${version}, expected ${OPENCLAW_VERSION}`, 'corepack pnpm install');
}

async function checkOpenclawConfig(): Promise<Result> {
  const { configPath } = localOpenClaw();
  if (!existsSync(configPath)) return fail(`${path.relative(ROOT_DIR, configPath)} is missing`, '`pnpm openclaw:config` (or `pnpm start`, which runs it).');
  const r = parseCliJson((await openclaw(['config', 'validate', '--json'])).stdout) as { valid?: boolean; errors?: unknown } | undefined;
  return r?.valid ? pass(path.relative(ROOT_DIR, configPath)) : fail(`invalid: ${JSON.stringify(r?.errors ?? r).slice(0, 300)}`, '`pnpm openclaw:config` rewrites it.');
}

function checkAgents(): Result {
  const { configPath } = localOpenClaw();
  if (!existsSync(configPath)) return fail('no config yet', '`pnpm openclaw:config`');
  const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, any>;
  const problems = configProblems(
    { entries: cfg.agents?.entries, bindings: cfg.bindings, telegram: cfg.channels?.telegram },
    ROOT_DIR,
    env().TELEGRAM_ALLOWED_USER_ID,
  );
  return problems.length ? fail(problems.join('; '), '`pnpm openclaw:config` rewrites the config from .env.') : pass('cos, explore, execute, qa; Telegram → cos, owner only');
}

async function checkPlugin(): Promise<Result> {
  const out = await openclaw(['plugins', 'inspect', PLUGIN_ID, '--runtime', '--json']);
  const problems = out.code === 0 ? pluginProblems(parseCliJson(out.stdout)) : [`openclaw plugins inspect failed (exit ${out.code})`];
  return problems.length ? fail(problems.join('; '), '`pnpm plugin:build && pnpm openclaw:config`, then restart the gateway.') : pass('loaded: tools, hooks and result middleware');
}

async function checkGateway(): Promise<Result> {
  const out = await openclaw(['gateway', 'status', '--json', '--require-rpc'], 30_000);
  return out.code === 0
    ? pass(`http://127.0.0.1:${GATEWAY_PORT} answers`)
    : fail('not running', '`pnpm start` in its own terminal (Ctrl+C stops it).');
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
          : fail('empty', 'Send any message to @userinfobot in Telegram and put the id it replies with into .env.'),
    },
    { name: `Browser (${e.BROWSER_MODE})`, required: true, run: checkBrowserReady },
    { name: 'Chrome is the default browser', required: false, run: checkDefaultBrowser },
    { name: 'PLAYWRIGHT_MCP_EXTENSION_TOKEN', required: true, run: checkExtensionToken },
    { name: 'Order form details (CHECKOUT_*)', required: true, run: checkOrderFormDetails },
    {
      name: 'Explore skill',
      required: true,
      run: () =>
        existsSync(SKILL_FILE)
          ? pass(path.relative(ROOT_DIR, SKILL_FILE))
          : fail(`${path.relative(ROOT_DIR, SKILL_FILE)} is missing`, 'Restore it from git: `git checkout -- agents/explore`.'),
    },
    {
      name: 'Plugin bundle',
      required: true,
      run: () => {
        const b = bundleIsCurrent(ROOT_DIR);
        return b.ok ? pass(b.detail) : fail(b.detail, 'pnpm plugin:build');
      },
    },
    { name: `OpenClaw ${OPENCLAW_VERSION}`, required: true, run: checkOpenclawPackage },
    { name: 'OpenClaw config', required: true, run: checkOpenclawConfig },
    { name: 'Agents and Telegram', required: true, run: checkAgents },
    { name: 'Plugin loaded', required: true, run: checkPlugin },
    { name: 'Gateway running', required: true, run: checkGateway },
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
