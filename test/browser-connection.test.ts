import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chromeUserDataDir, PLAYWRIGHT_EXTENSION_ID, PLAYWRIGHT_EXTENSION_URL } from '../src/browser/chrome.js';
import { browserConnection, checkBrowser, describeBasketBrowser, requireBrowser, type BrowserConnection } from '../src/browser/connection.js';
import { browserToolset, type BrowserMcpKind } from '../src/browser/mcp.js';
import { env, resetEnvCache } from '../src/config/env.js';

const EXTENSION: BrowserConnection = { mode: 'extension', profileDir: 'Profile 4', token: 'ext-token' };
const CDP: BrowserConnection = { mode: 'cdp', cdpUrl: 'http://127.0.0.1:9333' };

const toolset = (kind: BrowserMcpKind, connection: BrowserConnection) =>
  browserToolset(kind, { role: 'execute', connection, outputDir: '/tmp/poo-test', blockedOrigins: [], session: 'test' });

describe('browserToolset per connection', () => {
  it('extension: Playwright MCP connects through the extension in the configured profile, with the token', () => {
    const { server } = toolset('playwright', EXTENSION);
    expect(server.args).toEqual(expect.arrayContaining(['--extension', '--profile-dir-name', 'Profile 4']));
    expect(server.args).not.toContain('--cdp-endpoint');
    expect(server.env?.PLAYWRIGHT_MCP_EXTENSION_TOKEN).toBe('ext-token');
  });

  it('extension without a token: the server gets an empty one, so a token from the parent environment cannot leak in', () => {
    const { server } = toolset('playwright', { mode: 'extension', profileDir: 'Default' });
    expect(server.env?.PLAYWRIGHT_MCP_EXTENSION_TOKEN).toBe('');
  });

  it('cdp: Playwright MCP attaches to the endpoint and never holds the extension token', () => {
    const { server } = toolset('playwright', CDP);
    expect(server.args).toEqual(expect.arrayContaining(['--cdp-endpoint', 'http://127.0.0.1:9333']));
    expect(server.args).not.toContain('--extension');
    expect(server.env?.PLAYWRIGHT_MCP_EXTENSION_TOKEN).toBe('');
  });

  it('agent-browser works over CDP only', () => {
    expect(toolset('agent-browser', CDP).server.env?.AGENT_BROWSER_CDP).toBe('9333');
    expect(toolset('agent-browser', CDP).server.env?.PLAYWRIGHT_MCP_EXTENSION_TOKEN).toBe('');
    expect(() => toolset('agent-browser', EXTENSION)).toThrow(/CDP only/);
  });
});

describe('browser settings', () => {
  const KEYS = ['BROWSER_MODE', 'CHROME_PROFILE_DIR', 'PLAYWRIGHT_MCP_EXTENSION_TOKEN', 'EXECUTE_BROWSER_MCP', 'QA_BROWSER_MCP'];
  const configure = (values: Record<string, string>) => {
    Object.assign(process.env, values);
    resetEnvCache();
  };
  afterEach(() => {
    for (const key of KEYS) delete process.env[key];
    resetEnvCache();
  });

  it('defaults to Playwright through the extension in the "Default" Chrome profile', () => {
    configure({ PLAYWRIGHT_MCP_EXTENSION_TOKEN: '  ' });
    const e = env();
    expect([e.EXECUTE_BROWSER_MCP, e.QA_BROWSER_MCP]).toEqual(['playwright', 'playwright']);
    expect(browserConnection(e)).toEqual({ mode: 'extension', profileDir: 'Default', token: undefined });
  });

  it.each(['EXECUTE_BROWSER_MCP', 'QA_BROWSER_MCP'])('rejects agent-browser for %s in extension mode, allows it over CDP', (key) => {
    configure({ [key]: 'agent-browser' });
    expect(() => env()).toThrow(/agent-browser connects over CDP only/);
    configure({ BROWSER_MODE: 'cdp' });
    expect(env()[key as 'QA_BROWSER_MCP']).toBe('agent-browser');
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
