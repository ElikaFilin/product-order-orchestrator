/**
 * One isolated OpenClaw gateway per scenario, run from the repo's pinned `openclaw` in the foreground: its own
 * state dir, config, HOME and port, our config built by buildE2eConfig (mock Anthropic, fake Telegram, throwaway
 * Chrome over CDP), and a copy of the agent workspaces so the real SKILL.md never changes. Nothing global.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, openSync, readFileSync } from 'node:fs';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { buildE2eConfig } from '../../../src/openclaw/config.js';

const execFileAsync = promisify(execFile);

export const MODEL_IDS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];

export interface GatewayOptions {
  repoRoot: string;
  workDir: string;
  port: number;
  anthropicUrl: string;
  telegramUrl: string;
  telegramToken: string;
  telegramUserId: number;
  cdpUrl: string;
}

export interface TaskInfo {
  id: string;
  agent: string;
  state: string;
  childSessionKey?: string;
}

export class E2eGateway {
  private exit: string | undefined;

  private constructor(
    readonly opts: GatewayOptions,
    readonly workspaceRoot: string,
    readonly stateFile: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly child: ChildProcess,
  ) {
    child.on('exit', (code, signal) => (this.exit = `gateway exited (code ${code}, signal ${signal})`));
  }

  static async start(opts: GatewayOptions): Promise<E2eGateway> {
    const dir = (...p: string[]) => path.join(opts.workDir, ...p);
    for (const d of ['state', 'home', 'repo', 'playwright']) await mkdir(dir(d), { recursive: true });
    // The workspaces (AGENTS.md, the skill) are copied: scenario C edits the product list.
    await cp(path.join(opts.repoRoot, 'agents'), dir('repo', 'agents'), { recursive: true });
    const token = `e2e-${opts.port}-gateway-token-0123456789`;
    const config = buildE2eConfig(
      {
        repoRoot: opts.repoRoot,
        workspaceRoot: dir('repo'),
        nodePath: process.execPath,
        telegramUserId: String(opts.telegramUserId),
        browser: { mode: 'cdp', cdpUrl: opts.cdpUrl },
        basketBrowser: 'the test Chrome',
        playwrightOutputDir: dir('playwright'),
        stateFile: dir('poo-state.json'),
      },
      { port: opts.port, token, anthropicBaseUrl: opts.anthropicUrl, telegramApiRoot: opts.telegramUrl, modelIds: MODEL_IDS },
    );
    await writeFile(dir('openclaw.json'), JSON.stringify(config, null, 2));

    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: dir('home'),
      USER: process.env.USER ?? 'e2e',
      TMPDIR: process.env.TMPDIR ?? '/tmp',
      LANG: 'en_US.UTF-8',
      OPENCLAW_STATE_DIR: dir('state'),
      OPENCLAW_CONFIG_PATH: dir('openclaw.json'),
      OPENCLAW_GATEWAY_TOKEN: token,
      ANTHROPIC_API_KEY: 'sk-ant-e2e-fake-key-local-mock-only',
      TELEGRAM_BOT_TOKEN: opts.telegramToken,
      OPENCLAW_DISABLE_BONJOUR: '1',
      OPENCLAW_NO_AUTO_UPDATE: '1',
      OPENCLAW_SKIP_CRON: '1',
      DO_NOT_TRACK: '1',
      NO_PROXY: '127.0.0.1,localhost',
    };
    const log = openSync(dir('gateway.log'), 'a');
    const child = spawn(process.execPath, [cli(opts.repoRoot), 'gateway', 'run', '--port', String(opts.port)], {
      cwd: dir('repo'),
      env,
      stdio: ['ignore', log, log],
      detached: true,
    });
    return new E2eGateway(opts, dir('repo'), dir('poo-state.json'), env, child);
  }

  get exited(): string | undefined {
    return this.exit;
  }

  /** The plugin's tasks, from its state file. */
  tasks(): TaskInfo[] {
    if (!existsSync(this.stateFile)) return [];
    return (JSON.parse(readFileSync(this.stateFile, 'utf8')) as { tasks: TaskInfo[] }).tasks;
  }

  orderState(): { expected: Array<{ name: string; qty: number }>; lastQa?: { verdict: string; modalOpened: boolean } } {
    return (JSON.parse(readFileSync(this.stateFile, 'utf8')) as { order: never }).order;
  }

  /** A session's transcript, as the Control UI reads it (chat.history). */
  async history(sessionKey: string): Promise<Array<Record<string, any>>> {
    const { stdout } = await execFileAsync(
      process.execPath,
      [cli(this.opts.repoRoot), 'gateway', 'call', 'chat.history', '--port', String(this.opts.port), '--params', JSON.stringify({ sessionKey, limit: 500 }), '--json'],
      { env: this.env, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
    );
    return (JSON.parse(stdout) as { messages: Array<Record<string, any>> }).messages;
  }

  async stop(): Promise<void> {
    const pid = this.child.pid;
    if (this.exit || !pid) return;
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      // already gone
    }
    for (let i = 0; i < 100 && !this.exit; i++) await sleep(100);
    if (!this.exit) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
}

function cli(repoRoot: string): string {
  return path.join(repoRoot, 'node_modules', 'openclaw', 'openclaw.mjs');
}

/** Is a TCP port free on 127.0.0.1? */
export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

/** `count` free ports, scanning upward from `from`. */
export async function pickPorts(count: number, from: number, to: number): Promise<number[]> {
  const out: number[] = [];
  for (let p = from; p <= to && out.length < count; p++) if (await portFree(p)) out.push(p);
  if (out.length < count) throw new Error(`not enough free ports in ${from}-${to}`);
  return out;
}
