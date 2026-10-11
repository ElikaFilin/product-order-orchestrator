/**
 * `pnpm openclaw <command>`: the repo's pinned OpenClaw CLI, pointed at this project's state and config
 * (.runtime/openclaw/) with the secrets from .env. For example `pnpm openclaw dashboard`,
 * `pnpm openclaw logs --follow`, `pnpm openclaw gateway status`.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { localOpenClaw, openclawEnv } from '../openclaw/local.js';

const paths = localOpenClaw();
if (!existsSync(paths.configPath)) {
  process.stderr.write('No OpenClaw config yet: run `pnpm openclaw:config` (or `pnpm start`, which also does it).\n');
}
const child = spawn(process.execPath, [paths.cli, ...process.argv.slice(2)], { stdio: 'inherit', env: openclawEnv() });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
