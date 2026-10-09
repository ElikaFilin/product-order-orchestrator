/**
 * "COS can spawn sub-agents": starts a sub-agent's A2A server process the first time COS needs it
 * and reuses whatever already answers on the agent's port (e.g. a process started by the launcher).
 * A child that died is started again on the next delegation.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { subAgentSpec, type SubAgentName, type SubAgentSpec } from '../../config/agents.js';
import { ROOT_DIR, runtimeDir } from '../../config/env.js';
import type { Telemetry } from '../../observability/telemetry.js';
import { fetchAgentCard } from '../../shared/a2a.js';
import { createLogger } from '../../shared/logger.js';

const START_TIMEOUT_MS = 25_000;
const STOP_GRACE_MS = 5_000;
const POLL_MS = 300;

const isAlive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

/** COS's environment without the Telegram settings: sub-agents never talk to Telegram. */
export function subAgentEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('TELEGRAM_')));
}

export class SubagentSupervisor {
  private readonly children = new Map<SubAgentName, ChildProcess>();
  private readonly starting = new Map<SubAgentName, Promise<void>>();
  private readonly log = createLogger('cos:supervisor');

  constructor(private readonly telemetry: Telemetry) {}

  /** Resolve once the agent serves its card; spawn it if nothing answers. Concurrent calls share one start. */
  ensureRunning(name: SubAgentName): Promise<void> {
    let pending = this.starting.get(name);
    if (!pending) {
      pending = this.start(name).finally(() => this.starting.delete(name));
      this.starting.set(name, pending);
    }
    return pending;
  }

  /** SIGTERM every child this process started, SIGKILL the ones still alive after 5 s. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.children.values()].map((child) => this.stop(child)));
  }

  // ---------- internals ----------

  private async start(name: SubAgentName): Promise<void> {
    const spec = subAgentSpec(name);
    if (await fetchAgentCard(spec.baseUrl)) return;
    const running = this.children.get(name);
    const child = running && isAlive(running) ? running : this.spawn(spec);
    await this.waitForCard(spec, child);
  }

  private spawn(spec: SubAgentSpec): ChildProcess {
    const logFile = this.logFile(spec.name);
    mkdirSync(path.dirname(logFile), { recursive: true });
    const fd = openSync(logFile, 'a');
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, ['--import', 'tsx', spec.entry], {
        cwd: ROOT_DIR,
        env: subAgentEnv(), // ports and settings come from the same env as COS (subAgentSpec)
        stdio: ['ignore', fd, fd],
      });
    } finally {
      closeSync(fd); // the child has its own copy
    }
    this.children.set(spec.name, child);
    this.log.info({ agent: spec.name, pid: child.pid, logFile }, 'spawned sub-agent');
    this.telemetry.emit('log', {
      level: 'info',
      event: 'spawned',
      subAgent: spec.name,
      pid: child.pid,
      logFile,
      text: `spawned ${spec.name} agent (pid ${child.pid})`,
    });
    child.once('error', (err) => this.telemetry.error(err, { subAgent: spec.name, source: 'spawn' }));
    child.once('exit', (code, signal) => {
      if (this.children.get(spec.name) === child) this.children.delete(spec.name);
      this.log.info({ agent: spec.name, code, signal }, 'sub-agent exited');
      this.telemetry.emit('log', {
        level: code === 0 || signal === 'SIGTERM' ? 'info' : 'warn',
        event: 'exited',
        subAgent: spec.name,
        code,
        signal,
        text: `${spec.name} agent exited (${signal ?? `code ${code}`})`,
      });
    });
    return child;
  }

  private async waitForCard(spec: SubAgentSpec, child: ChildProcess): Promise<void> {
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await fetchAgentCard(spec.baseUrl)) return;
      if (!isAlive(child)) {
        // Another process may have taken the port first (e.g. the launcher); then that one serves.
        if (await fetchAgentCard(spec.baseUrl)) return;
        throw new Error(
          `The ${spec.name} agent exited during startup (${child.signalCode ?? `code ${child.exitCode}`}). See ${this.logFile(spec.name)}.`,
        );
      }
      await delay(POLL_MS);
    }
    throw new Error(`The ${spec.name} agent did not answer on ${spec.baseUrl} within ${START_TIMEOUT_MS / 1000} s. See ${this.logFile(spec.name)}.`);
  }

  private async stop(child: ChildProcess): Promise<void> {
    if (!isAlive(child)) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    await Promise.race([exited, delay(STOP_GRACE_MS, undefined, { ref: false })]);
    if (isAlive(child)) {
      child.kill('SIGKILL');
      await exited;
    }
  }

  private logFile(name: SubAgentName): string {
    return runtimeDir('logs', `${name}.log`);
  }
}
