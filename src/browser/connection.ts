/**
 * How Execute and QA reach the browser (BROWSER_MODE) and the pre-flight check every task runs before it starts
 * its browser MCP server:
 *  - extension: the user's own Chrome profile through the Playwright Extension, no debugging port;
 *  - cdp: a Chrome started with remote debugging (`pnpm browser:chrome`, the smoke and e2e tests).
 */
import type { Env } from '../config/env.js';
import { AgentTaskError } from '../core/errors.js';
import { checkCdp } from './cdp.js';
import { PLAYWRIGHT_EXTENSION_URL, readChromeProfile } from './chrome.js';

export type BrowserConnection =
  | { mode: 'extension'; profileDir: string; token?: string }
  | { mode: 'cdp'; cdpUrl: string };

export interface BrowserCheck {
  ok: boolean;
  detail: string;
  /** How the user fixes it, for a failed check. */
  hint?: string;
}

type ConnectionEnv = Pick<Env, 'BROWSER_MODE' | 'CHROME_PROFILE_DIR' | 'PLAYWRIGHT_MCP_EXTENSION_TOKEN' | 'BROWSER_CDP_URL'>;

export function browserConnection(e: ConnectionEnv): BrowserConnection {
  return e.BROWSER_MODE === 'extension'
    ? { mode: 'extension', profileDir: e.CHROME_PROFILE_DIR, token: e.PLAYWRIGHT_MCP_EXTENSION_TOKEN }
    : { mode: 'cdp', cdpUrl: e.BROWSER_CDP_URL };
}

/**
 * Extension mode: the extension is installed in the configured profile (Chrome itself need not run: Playwright MCP
 * opens it). CDP mode: the endpoint answers.
 */
export async function checkBrowser(connection: BrowserConnection): Promise<BrowserCheck> {
  if (connection.mode === 'extension') {
    const profile = await readChromeProfile(connection.profileDir);
    const label = `Chrome profile "${profile.name}" (${profile.dir})`;
    if (profile.hasExtension) return { ok: true, detail: `${label} has the Playwright Extension` };
    return {
      ok: false,
      detail: `the Playwright Extension is not installed in ${label}`,
      hint:
        `In Chrome, switch to the profile your basket should live in and install the extension from ${PLAYWRIGHT_EXTENSION_URL}. ` +
        'If that is not the "Default" profile, set CHROME_PROFILE_DIR in .env to its directory name. Then ask me to retry.',
    };
  }
  const status = await checkCdp(connection.cdpUrl);
  if (status.ok) return { ok: true, detail: `${status.browser ?? 'unknown browser'} at ${connection.cdpUrl}` };
  return {
    ok: false,
    detail: `no browser at ${connection.cdpUrl} (${status.error})`,
    hint: 'Run `pnpm browser:chrome` on the Mac (a dedicated Chrome profile with remote debugging), then ask me to retry.',
  };
}

/** Throw a BROWSER_NOT_CONNECTED task error, with the fix for the user, unless checkBrowser passes. */
export async function requireBrowser(connection: BrowserConnection): Promise<void> {
  const check = await checkBrowser(connection);
  if (!check.ok) throw new AgentTaskError('BROWSER_NOT_CONNECTED', check.detail, check.hint);
}

/** Where the final basket link must be opened, as COS says it: the basket lives only where the agents filled it. */
export async function describeBasketBrowser(connection: BrowserConnection): Promise<string> {
  if (connection.mode === 'cdp') return 'the Chrome window the agents use (the `pnpm browser:chrome` window), not your everyday browser';
  const profile = await readChromeProfile(connection.profileDir);
  return `Chrome, in your "${profile.name}" profile (if the link opens in another Chrome profile, open it in that one)`;
}
