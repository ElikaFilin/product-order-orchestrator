/**
 * The user's own Google Chrome on macOS (BROWSER_MODE=extension). Playwright MCP finds the profile that has the
 * Playwright MCP Bridge extension on disk, in the same place read here, and connects through the extension.
 */
import { access, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Chrome Web Store id of "Playwright MCP Bridge", the extension Playwright MCP --extension connects to. */
export const PLAYWRIGHT_EXTENSION_ID = 'mmlmfjhmonkocbjadbfplnigmagldckm';
export const PLAYWRIGHT_EXTENSION_URL = `https://chromewebstore.google.com/detail/${PLAYWRIGHT_EXTENSION_ID}`;

export interface ChromeProfile {
  /** Directory name inside Chrome's user data directory: "Default", "Profile 4", ... */
  dir: string;
  /** Name shown in Chrome's profile menu, or the directory name when Chrome has none recorded. */
  name: string;
  hasExtension: boolean;
}

/** Where Chrome keeps its profiles (read at call time: tests point HOME elsewhere). */
export function chromeUserDataDir(): string {
  return path.join(os.homedir(), 'Library/Application Support/Google/Chrome');
}

export async function readChromeProfile(dir: string): Promise<ChromeProfile> {
  const userDataDir = chromeUserDataDir();
  const [name, hasExtension] = await Promise.all([
    profileName(userDataDir, dir),
    exists(path.join(userDataDir, dir, 'Extensions', PLAYWRIGHT_EXTENSION_ID)),
  ]);
  return { dir, name: name ?? dir, hasExtension };
}

async function profileName(userDataDir: string, dir: string): Promise<string | undefined> {
  try {
    const localState = JSON.parse(await readFile(path.join(userDataDir, 'Local State'), 'utf8')) as {
      profile?: { info_cache?: Record<string, { name?: unknown }> };
    };
    const name = localState.profile?.info_cache?.[dir]?.name;
    return typeof name === 'string' && name.trim() !== '' ? name : undefined;
  } catch {
    return undefined; // Chrome not installed or never started: the directory name is all there is
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
