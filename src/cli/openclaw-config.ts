/**
 * `pnpm openclaw:config`: writes the project's OpenClaw configuration to .runtime/openclaw/openclaw.json, built from
 * .env and this checkout's absolute paths. It holds no secrets (only `${VAR}` references): the gateway process gets
 * them from .env. It does hold the CHECKOUT_* order form details when they are set (.runtime/ is not in git).
 * `pnpm start` runs this before every start, so edit the generator, not the file.
 * `--print` writes it to stdout instead.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { browserConnection, describeBasketBrowser } from '../browser/connection.js';
import { checkoutDetails, env, ROOT_DIR, runtimeDir } from '../config/env.js';
import { errorMessage } from '../core/errors.js';
import { buildLocalConfig } from '../openclaw/config.js';
import { GATEWAY_PORT, localOpenClaw } from '../openclaw/local.js';

async function main(): Promise<void> {
  const e = env();
  if (e.TELEGRAM_ALLOWED_USER_ID === undefined) throw new Error('TELEGRAM_ALLOWED_USER_ID is empty in .env: COS needs the owner chat.');
  const connection = browserConnection(e);
  const checkout = checkoutDetails(e);
  const config = buildLocalConfig(
    {
      repoRoot: ROOT_DIR,
      workspaceRoot: ROOT_DIR,
      nodePath: process.execPath,
      telegramUserId: String(e.TELEGRAM_ALLOWED_USER_ID),
      browser: connection,
      basketBrowser: await describeBasketBrowser(connection),
      checkout,
      playwrightOutputDir: runtimeDir('playwright'),
    },
    GATEWAY_PORT,
  );
  const json = `${JSON.stringify(config, null, 2)}\n`;
  if (process.argv.includes('--print')) {
    process.stdout.write(json);
    return;
  }
  const file = localOpenClaw().configPath;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, json);
  const form = checkout ? 'filled by Execute' : 'left to you';
  process.stdout.write(`Wrote ${path.relative(ROOT_DIR, file)} (browser: ${connection.mode}, gateway: http://127.0.0.1:${GATEWAY_PORT}, order form: ${form}).\n`);
}

main().catch((err) => {
  process.stderr.write(`openclaw:config failed: ${errorMessage(err)}\n`);
  process.exit(1);
});
