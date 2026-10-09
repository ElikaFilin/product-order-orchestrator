/**
 * Starts the REAL system (`src/launcher.ts`: dashboard hub + COS, COS spawns the sub-agents itself) as a
 * process group with an explicit, clean environment, tracks every descendant process while it runs, and
 * on stop checks that the graceful shutdown left nothing behind (anything left is killed and reported).
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const requireResolve = createRequire(import.meta.url).resolve;

/** Fixed in src/browser/mcp.ts. */
export const AGENT_BROWSER_SOCKET_DIR = '/tmp/poo-agent-browser';

interface Proc {
  pid: number;
  ppid: number;
  pgid: number;
  command: string;
}

async function processTable(): Promise<Proc[]> {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,pgid=,command='], { maxBuffer: 32 * 1024 * 1024 });
  return stdout
    .split('\n')
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), command: m[4]! }));
}

export interface StopReport {
  exitCode: number | null;
  signal: string | null;
  stopMs: number;
  /** Processes of this run still alive after the graceful stop (they were killed). */
  leftovers: string[];
  /** agent-browser daemon sockets/files of this run left in the socket dir (they were closed/removed). */
  agentBrowserLeftovers: string[];
  /** How many distinct processes the run had (launcher included). */
  processCount: number;
  commands: string[];
}

export class RunningSystem {
  private readonly seen = new Map<number, string>();
  private sampler: NodeJS.Timeout | undefined;
  private sampling = Promise.resolve();
  private socketsBefore = new Set<string>();

  private constructor(
    private readonly child: ChildProcess,
    readonly logFile: string,
  ) {}

  get pid(): number {
    return this.child.pid ?? -1;
  }

  get exited(): boolean {
    return this.child.exitCode !== null || this.child.signalCode !== null;
  }

  static async start(opts: { repoDir: string; env: Record<string, string>; logFile: string }): Promise<RunningSystem> {
    const fd = openSync(opts.logFile, 'a');
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(opts.repoDir, 'src', 'launcher.ts')], {
      cwd: opts.repoDir,
      env: opts.env,
      stdio: ['ignore', fd, fd],
      detached: true, // own process group: nothing of this run can outlive cleanup
    });
    closeSync(fd);
    const system = new RunningSystem(child, opts.logFile);
    system.socketsBefore = new Set(await readdir(AGENT_BROWSER_SOCKET_DIR).catch(() => [] as string[]));
    system.sampler = setInterval(() => {
      system.sampling = system.sampling.then(() => system.sample()).catch(() => undefined);
    }, 700);
    return system;
  }

  /** Record every live descendant of the launcher. */
  private async sample(): Promise<void> {
    if (!this.child.pid) return;
    const table = await processTable();
    const children = new Map<number, Proc[]>();
    for (const p of table) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p]);
    const stack = [this.child.pid];
    while (stack.length) {
      const pid = stack.pop()!;
      for (const c of children.get(pid) ?? []) {
        if (!this.seen.has(c.pid)) this.seen.set(c.pid, c.command);
        stack.push(c.pid);
      }
    }
  }

  async snapshotCommands(): Promise<string[]> {
    await this.sample().catch(() => undefined);
    return [...this.seen.values()];
  }

  async stop(graceMs = 25_000): Promise<StopReport> {
    await this.sample().catch(() => undefined);
    const t0 = Date.now();
    const exited = new Promise<void>((r) => (this.exited ? r() : this.child.once('exit', () => r())));
    if (!this.exited) this.child.kill('SIGTERM'); // the launcher's own graceful shutdown path
    await Promise.race([exited, sleep(graceMs, undefined, { ref: false })]);
    const stopMs = Date.now() - t0;
    if (this.sampler) clearInterval(this.sampler);
    await this.sampling;
    await sleep(500);

    const table = await processTable();
    const alive = new Map(table.map((p) => [p.pid, p]));
    const leftovers: string[] = [];
    for (const [pid, command] of this.seen) {
      const p = alive.get(pid);
      if (p && p.command === command) leftovers.push(`${pid} ${command.slice(0, 200)}`);
    }
    for (const p of table) {
      if (p.pgid === this.child.pid && !this.seen.has(p.pid) && p.pid !== this.child.pid) leftovers.push(`${p.pid} ${p.command.slice(0, 200)}`);
    }
    // Kill whatever is left: the process group first, then any tracked process that left the group.
    if (this.child.pid) {
      try {
        process.kill(-this.child.pid, 'SIGKILL');
      } catch {
        // group already gone
      }
    }
    for (const line of leftovers) {
      try {
        process.kill(Number(line.split(' ')[0]), 'SIGKILL');
      } catch {
        // already gone
      }
    }
    const agentBrowserLeftovers = await this.cleanAgentBrowser();
    return {
      exitCode: this.child.exitCode,
      signal: this.child.signalCode,
      stopMs,
      leftovers,
      agentBrowserLeftovers,
      processCount: this.seen.size + 1,
      commands: [...this.seen.values()],
    };
  }

  /** agent-browser daemons detach from their parent: check the sockets this run created. */
  private async cleanAgentBrowser(): Promise<string[]> {
    const now = await readdir(AGENT_BROWSER_SOCKET_DIR).catch(() => [] as string[]);
    const created = now.filter((f) => !this.socketsBefore.has(f) && /^(qa|execute)-/.test(f));
    const leftovers: string[] = [];
    for (const file of created) {
      const full = path.join(AGENT_BROWSER_SOCKET_DIR, file);
      if (file.endsWith('.sock') && (await acceptsConnections(full))) {
        leftovers.push(`${file} (daemon still running)`);
        await this.closeAgentBrowserDaemon(file.replace(/\.sock$/, ''));
      } else {
        leftovers.push(file);
      }
      await rm(full, { force: true }).catch(() => undefined);
    }
    return leftovers;
  }

  private async closeAgentBrowserDaemon(session: string): Promise<void> {
    const cli = path.join(path.dirname(requireResolve('agent-browser/package.json')), 'bin', 'agent-browser.js');
    await execFileAsync(process.execPath, [cli, 'close'], {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', AGENT_BROWSER_SESSION: session, AGENT_BROWSER_SOCKET_DIR },
      timeout: 10_000,
    }).catch(() => undefined);
  }
}

function acceptsConnections(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const conn = net.connect(socketPath);
    conn.once('connect', () => {
      conn.destroy();
      resolve(true);
    });
    conn.once('error', () => resolve(false));
  });
}

/** Is a TCP port free on 127.0.0.1? */
export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

/** `count` free ports, scanning upward from `from` (deterministic when the range is free). */
export async function pickPorts(count: number, from: number, to: number): Promise<number[]> {
  const out: number[] = [];
  for (let p = from; p <= to && out.length < count; p++) if (await portFree(p)) out.push(p);
  if (out.length < count) throw new Error(`not enough free ports in ${from}-${to}`);
  return out;
}
