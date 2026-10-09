/**
 * Entry point of the dashboard hub process (`pnpm dashboard`, or started by the launcher).
 * Open http://127.0.0.1:41010 (DASHBOARD_HOST:DASHBOARD_PORT).
 */
import { SUB_AGENTS, subAgentSpec, type SubAgentName } from '../../config/agents.js';
import { env, runtimeDir } from '../../config/env.js';
import { fetchAgentCard } from '../../shared/a2a.js';
import { createLogger, errorMessage } from '../../shared/logger.js';
import { pruneOlderThan } from '../../shared/retention.js';
import { listShops } from '../../shops/index.js';
import { startHub } from './hub.js';

async function main(): Promise<void> {
  const e = env();
  const log = createLogger('hub');
  const eventsDir = runtimeDir('events');
  const pruned = await pruneOlderThan(eventsDir, e.RUNTIME_RETENTION_DAYS);
  if (pruned.length) log.info({ pruned }, 'deleted old event journal days');
  const hub = await startHub({
    host: e.DASHBOARD_HOST,
    port: e.DASHBOARD_PORT,
    eventsDir,
    links: {
      clawmetryUrl: e.CLAWMETRY_URL,
      shops: listShops().map((s) => ({ id: s.id, name: s.name, url: s.baseUrl })),
    },
    // Sub-agents start lazily, so a card left "idle" by a run that ended without a word would stay wrong for long.
    staleCheck: {
      agents: SUB_AGENTS,
      alive: async (agent) => Boolean(await fetchAgentCard(subAgentSpec(agent as SubAgentName).baseUrl)),
    },
  });
  process.stderr.write(`Dashboard: ${hub.url}\n`);

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'shutting down');
    await Promise.race([hub.close(), new Promise((r) => setTimeout(r, 3_000))]);
    process.exit(0);
  };
  if (process.env.POO_LAUNCHED === '1') {
    // Ctrl+C reaches the whole process group: under the launcher, stay up until it stops us (SIGTERM) after
    // COS and the sub-agents have sent their last events.
    process.on('SIGINT', () => log.debug('SIGINT ignored: the launcher stops the hub last'));
  } else {
    process.once('SIGINT', () => void stop('SIGINT'));
  }
  process.once('SIGTERM', () => void stop('SIGTERM'));
}

main().catch((err) => {
  const busy = (err as NodeJS.ErrnoException).code === 'EADDRINUSE';
  const e = busy ? env() : undefined;
  process.stderr.write(
    `[hub] failed to start: ${errorMessage(err)}\n` +
      (e
        ? `[hub] Another program uses port ${e.DASHBOARD_PORT}: stop it (\`lsof -nP -iTCP:${e.DASHBOARD_PORT} -sTCP:LISTEN\` shows it) or set DASHBOARD_PORT in .env.\n`
        : ''),
  );
  process.exit(1);
});
