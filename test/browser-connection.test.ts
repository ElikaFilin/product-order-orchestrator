import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chromeUserDataDir, PLAYWRIGHT_EXTENSION_ID, PLAYWRIGHT_EXTENSION_URL } from '../src/browser/chrome.js';
import { browserConnection, checkBrowser, describeBasketBrowser, requireBrowser, type BrowserConnection } from '../src/browser/connection.js';
import { playwrightMcpArgs } from '../src/browser/playwright-mcp.js';
import { browserToolset } from '../src/core/browser/toolset.js';
import { env, resetEnvCache } from '../src/config/env.js';

const EXTENSION: BrowserConnection = { mode: 'extension', profileDir: 'Profile 4', token: 'ext-token' };
const CDP: BrowserConnection = { mode: 'cdp', cdpUrl: 'http://127.0.0.1:9333' };

const args = (connection: BrowserConnection, blockedOrigins: string[] = []) =>
  playwrightMcpArgs({ connection, outputDir: '/tmp/poo-test', blockedOrigins });

describe('Playwright MCP arguments per connection', () => {
  it('extension: connects through the extension in the configured profile, never with the token on the command line', () => {
    expect(args(EXTENSION)).toEqual(expect.arrayContaining(['--extension', '--profile-dir-name', 'Profile 4']));
    expect(args(EXTENSION)).not.toContain('--cdp-endpoint');
    expect(args(EXTENSION).join(' ')).not.toContain('ext-token');
  });

  it('cdp: attaches to the endpoint', () => {
    expect(args(CDP)).toEqual(expect.arrayContaining(['--cdp-endpoint', 'http://127.0.0.1:9333']));
    expect(args(CDP)).not.toContain('--extension');
  });

  it('blocks the checkout origins of every shop once, semicolon-separated', () => {
    const a = args(CDP, ['https://forms.tildaapi.com', 'https://forms2.tildacdn.com', 'https://forms.tildaapi.com']);
    expect(a.slice(a.indexOf('--blocked-origins'))).toEqual(['--blocked-origins', 'https://forms.tildaapi.com;https://forms2.tildacdn.com']);
    expect(args(CDP)).not.toContain('--blocked-origins');
  });
});

describe('browserToolset', () => {
  it('names the tools with the OpenClaw prefix by default, and QA alone may click', () => {
    const execute = browserToolset({ role: 'execute', mode: 'extension' });
    const qa = browserToolset({ role: 'qa', mode: 'extension' });
    expect(execute.evalTool.name).toBe('playwright__browser_evaluate');
    expect(execute.allowedTools).not.toContain('playwright__browser_click');
    expect(qa.allowedTools).toContain('playwright__browser_click');
    expect(browserToolset({ role: 'qa', mode: 'cdp', prefix: 'mcp__playwright__' }).clickTool.name).toBe('mcp__playwright__browser_click');
  });

  it('only the extension starts in the run\'s own tab and sees only its own tabs', () => {
    expect(browserToolset({ role: 'qa', mode: 'extension' })).toMatchObject({ startsInOwnTab: true, seesOnlyOwnTabs: true });
    expect(browserToolset({ role: 'qa', mode: 'cdp' })).toMatchObject({ startsInOwnTab: false, seesOnlyOwnTabs: false });
  });
});

describe('browser settings', () => {
  const KEYS = ['BROWSER_MODE', 'CHROME_PROFILE_DIR', 'PLAYWRIGHT_MCP_EXTENSION_TOKEN'];
  const configure = (values: Record<string, string>) => {
    Object.assign(process.env, values);
    resetEnvCache();
  };
  afterEach(() => {
    for (const key of KEYS) delete process.env[key];
    resetEnvCache();
  });

  it('defaults to the extension in the "Default" Chrome profile', () => {
    configure({ PLAYWRIGHT_MCP_EXTENSION_TOKEN: '  ' });
    expect(browserConnection(env())).toEqual({ mode: 'extension', profileDir: 'Default', token: undefined });
  });

  it('cdp mode uses the CDP endpoint', () => {
    configure({ BROWSER_MODE: 'cdp' });
    expect(browserConnection(env())).toEqual({ mode: 'cdp', cdpUrl: 'http://127.0.0.1:9333' });
  });
});

describe('extension pre-flight', () => {
  const realHome = process.env.HOME;
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'poo-chrome-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    process.env.HOME = realHome;
    await rm(home, { recursive: true, force: true });
  });

  const chromeWith = async (profiles: Record<string, { name: string; extension: boolean }>) => {
    const dataDir = chromeUserDataDir();
    const infoCache = Object.fromEntries(Object.entries(profiles).map(([dir, p]) => [dir, { name: p.name }]));
    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(dataDir, 'Local State'), JSON.stringify({ profile: { info_cache: infoCache } }));
    for (const [dir, p] of Object.entries(profiles)) {
      if (p.extension) await mkdir(path.join(dataDir, dir, 'Extensions', PLAYWRIGHT_EXTENSION_ID, '1.0_0'), { recursive: true });
    }
  };

  it('passes when the configured profile has the extension and names it for the final message', async () => {
    await chromeWith({ Default: { name: 'Work', extension: false }, 'Profile 4': { name: 'Home', extension: true } });
    expect(await checkBrowser(EXTENSION)).toMatchObject({ ok: true, detail: expect.stringContaining('"Home" (Profile 4)') });
    await expect(requireBrowser(EXTENSION)).resolves.toBeUndefined();
    expect(await describeBasketBrowser(EXTENSION)).toContain('Chrome, in your "Home" profile');
  });

  it('fails with an install hint when only another profile has the extension', async () => {
    await chromeWith({ Default: { name: 'Work', extension: true }, 'Profile 4': { name: 'Home', extension: false } });
    const check = await checkBrowser(EXTENSION);
    expect(check).toMatchObject({ ok: false, detail: expect.stringContaining('not installed in Chrome profile "Home"') });
    expect(check.hint).toContain(PLAYWRIGHT_EXTENSION_URL);
    await expect(requireBrowser(EXTENSION)).rejects.toMatchObject({ code: 'BROWSER_NOT_CONNECTED', hint: check.hint });
  });

  it('falls back to the directory name when Chrome has never run', async () => {
    expect(await checkBrowser(EXTENSION)).toMatchObject({ ok: false, detail: expect.stringContaining('"Profile 4" (Profile 4)') });
  });
});
