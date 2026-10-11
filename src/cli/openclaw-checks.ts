/**
 * The doctor's OpenClaw checks: what the project's gateway must have for this system (agents, Telegram owned by COS,
 * our plugin loaded). The decisions are plain functions over CLI output, so they are tested.
 */
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { SUB_AGENTS } from '../core/agents.js';
import { localOpenClaw, openclawEnv } from '../openclaw/local.js';
import { PLUGIN_ID } from '../plugin/config.js';
import { PLUGIN_TOOLS } from '../plugin/tools.js';

const exec = promisify(execFile);

export const OPENCLAW_VERSION = '2026.9.9';

/** The version of the repo's openclaw package, or undefined when it is not installed (pnpm install). */
export function installedOpenClawVersion(): string | undefined {
  const pkg = path.join(path.dirname(localOpenClaw().cli), 'package.json');
  return existsSync(pkg) ? (JSON.parse(readFileSync(pkg, 'utf8')) as { version?: string }).version : undefined;
}

/** Run the project's OpenClaw CLI (as `pnpm openclaw` does). */
export async function openclaw(args: string[], timeoutMs = 60_000): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await exec(process.execPath, [localOpenClaw().cli, ...args], { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: openclawEnv() });
    return { stdout, code: 0 };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: string };
    return { stdout: e.stdout ?? '', code: typeof e.code === 'number' ? e.code : 1 };
  }
}

/** The JSON value a `--json` command printed (the CLI may print a banner line first). */
export function parseCliJson(stdout: string): unknown {
  const start = stdout.search(/^[[{"]|^(?:true|false|null|\d)/m);
  if (start < 0) return undefined;
  try {
    return JSON.parse(stdout.slice(start));
  } catch {
    return undefined;
  }
}

interface AgentEntry {
  workspace?: string;
  tools?: { allow?: string[] };
}

/** What is wrong with our agents, the Telegram binding and the owner allow-list in the installed config. */
export function configProblems(
  cfg: { entries?: Record<string, AgentEntry>; bindings?: Array<{ agentId?: string; match?: { channel?: string } }>; telegram?: { enabled?: boolean; dmPolicy?: string; allowFrom?: string[] } },
  repoRoot: string,
  ownerId: number | undefined,
): string[] {
  const problems: string[] = [];
  for (const id of ['cos', ...SUB_AGENTS]) {
    const entry = cfg.entries?.[id];
    if (!entry) problems.push(`agent ${id} is missing`);
    else if (entry.workspace && path.resolve(entry.workspace) !== path.join(repoRoot, 'agents', id)) problems.push(`agent ${id} uses workspace ${entry.workspace}`);
  }
  const telegramOwners = (cfg.bindings ?? []).filter((b) => b.match?.channel === 'telegram').map((b) => b.agentId);
  if (telegramOwners.length !== 1 || telegramOwners[0] !== 'cos') problems.push(`Telegram is bound to ${telegramOwners.join(', ') || 'no agent'}, not to cos alone`);
  if (!cfg.telegram?.enabled) problems.push('the Telegram channel is not enabled');
  if (cfg.telegram?.dmPolicy !== 'allowlist') problems.push(`Telegram dmPolicy is ${cfg.telegram?.dmPolicy ?? 'unset'}, not allowlist`);
  if (ownerId !== undefined && JSON.stringify(cfg.telegram?.allowFrom) !== JSON.stringify([`tg:${ownerId}`])) problems.push('Telegram allowFrom is not just your user id');
  return problems;
}

/** What is wrong with the loaded plugin (from `plugins inspect --runtime --json`). */
export function pluginProblems(inspect: unknown): string[] {
  const r = (inspect ?? {}) as { plugin?: { status?: string; enabled?: boolean }; tools?: unknown[]; typedHooks?: Array<{ name?: string }> };
  const problems: string[] = [];
  if (r.plugin?.status !== 'loaded') problems.push(`status ${r.plugin?.status ?? 'unknown'}`);
  const tools = JSON.stringify(r.tools ?? []);
  const missing = PLUGIN_TOOLS.filter((t) => !tools.includes(`"${t}"`));
  if (missing.length) problems.push(`tools missing: ${missing.join(', ')}`);
  const hooks = new Set((r.typedHooks ?? []).map((h) => h.name));
  for (const hook of ['before_tool_call', 'before_prompt_build', 'message_sending', 'subagent_spawned', 'subagent_ended', 'before_reset']) {
    if (!hooks.has(hook)) problems.push(`hook ${hook} not registered`);
  }
  return problems;
}

/** The plugin bundle exists and is newer than every source file it is built from. */
export function bundleIsCurrent(repoRoot: string): { ok: boolean; detail: string } {
  const bundle = path.join(repoRoot, 'openclaw', 'plugin', 'dist', 'index.js');
  if (!existsSync(bundle)) return { ok: false, detail: 'openclaw/plugin/dist/index.js is missing' };
  const built = statSync(bundle).mtimeMs;
  const stale = sources(path.join(repoRoot, 'src')).filter((f) => !f.includes(`${path.sep}cli${path.sep}`) && statSync(f).mtimeMs > built);
  return stale.length
    ? { ok: false, detail: `older than ${path.relative(repoRoot, stale[0]!)}${stale.length > 1 ? ` and ${stale.length - 1} more` : ''}` }
    : { ok: true, detail: path.relative(repoRoot, bundle) };
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const full = path.join(dir, d.name);
    return d.isDirectory() ? sources(full) : d.name.endsWith('.ts') ? [full] : [];
  });
}

export { PLUGIN_ID };
