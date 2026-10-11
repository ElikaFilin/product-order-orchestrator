/**
 * How the Playwright MCP server is started for Execute and QA: the repository's own pinned @playwright/mcp (no npx),
 * attached to the browser that holds the basket. Never --isolated: the basket lives in the profile's localStorage.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import type { BrowserConnection } from './connection.js';

const require = createRequire(import.meta.url);

/** Absolute path of the Playwright MCP CLI in node_modules. */
export function playwrightMcpCli(): string {
  return path.join(path.dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js');
}

export interface PlaywrightMcpOptions {
  connection: BrowserConnection;
  /** Directory for the snapshots and screenshots the server writes. */
  outputDir: string;
  /** Network origins an agent tab must never reach (checkout endpoints of every shop). */
  blockedOrigins: readonly string[];
}

/** Arguments after the CLI path. */
export function playwrightMcpArgs(opts: PlaywrightMcpOptions): string[] {
  const connection =
    opts.connection.mode === 'extension'
      ? ['--extension', '--profile-dir-name', opts.connection.profileDir]
      : ['--cdp-endpoint', opts.connection.cdpUrl, '--cdp-timeout', '10000'];
  const args = [
    ...connection,
    '--output-dir',
    opts.outputDir,
    '--output-max-size',
    String(20 * 1024 * 1024),
    '--image-responses',
    'omit',
    // Do not echo evaluated code: the browser guard prepends the shop helper (~9 KB) to every eval.
    '--codegen',
    'none',
    '--timeout-action',
    '10000',
    '--timeout-navigation',
    '45000',
  ];
  if (opts.blockedOrigins.length) args.push('--blocked-origins', [...new Set(opts.blockedOrigins)].join(';'));
  return args;
}
