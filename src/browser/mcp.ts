/**
 * MCP servers that give Execute and QA access to the browser that holds the basket (never --isolated: the basket
 * lives in the real profile's localStorage):
 *  - Playwright MCP (@playwright/mcp), through the Playwright MCP Bridge extension in the user's Chrome profile
 *    (BROWSER_MODE=extension) or attached over CDP (BROWSER_MODE=cdp),
 *  - agent-browser MCP (vercel-labs/agent-browser), over CDP only, with its own pinned tab.
 * Both are spawned with the current Node binary from local node_modules (no npx, pinned versions).
 */
import { execFile } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { McpStdioServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { BrowserConnection } from './connection.js';

const require = createRequire(import.meta.url);
const pkgDir = (name: string) => path.dirname(require.resolve(`${name}/package.json`));
const execFileAsync = promisify(execFile);

/** agent-browser daemon sockets and session files; unix socket paths are limited to 103 bytes. */
const AGENT_BROWSER_SOCKET_DIR = '/tmp/poo-agent-browser';
const CLOSE_TIMEOUT_MS = 10_000;
const DAEMON_EXIT_MS = 3_000;

export type BrowserMcpKind = 'playwright' | 'agent-browser';
/** Execute changes the basket only through page scripts; QA also clicks the basket icon. */
export type BrowserRole = 'execute' | 'qa';

export interface BrowserToolset {
  kind: BrowserMcpKind;
  /** Key in options.mcpServers; tool names are mcp__<serverName>__<tool>. */
  serverName: string;
  server: McpStdioServerConfig;
  /** Exact tool names the agent is allowed to call. */
  allowedTools: string[];
  /** Tool that runs JavaScript in the page and the input field holding the code. */
  evalTool: { name: string; codeField: 'function' | 'script' };
  /** Tool that clicks an element and the input field holding its selector. */
  clickTool: { name: string; selectorField: 'target' | 'selector' };
  /**
   * The session's current tab already belongs to this run: agent-browser's pinned tab, or the connect page the
   * Playwright MCP Bridge extension opens for each connection. Attached over CDP, Playwright starts on a USER's tab.
   */
  startsInOwnTab: boolean;
  /**
   * The session sees only tabs opened for it: through the extension a connection is limited to its own tab group.
   * Only then may the run close its (current) tab when it is done.
   */
  seesOnlyOwnTabs: boolean;
  /** Fully-qualified tool name helper. */
  tool(name: string): string;
  /**
   * Call after the agent run. agent-browser's daemon outlives its MCP server (idling for 1 h, attached to the
   * browser): stop it and delete the session's files. The browser and the agent's tab stay open. Never throws.
   */
  cleanup(): Promise<void>;
}

/**
 * Playwright MCP tools an agent may use: open its own tab, look, wait, and run the shop helper. Nothing types,
 * presses keys or fills forms (the basket changes only through the helper), and nothing lists, selects or
 * closes the user's tabs. Excluded too: run_code_unsafe, file_upload, drag/drop, dialogs, resize.
 */
const PLAYWRIGHT_TOOLS = [
  'browser_tabs',
  'browser_navigate',
  'browser_snapshot',
  'browser_wait_for',
  'browser_evaluate',
  'browser_take_screenshot',
  'browser_console_messages',
];

/** agent-browser MCP tools (from `agent-browser mcp --tools core`) an agent may use; same rules as above. */
const AGENT_BROWSER_TOOLS = [
  'agent_browser_open',
  'agent_browser_snapshot',
  'agent_browser_wait_ms',
  'agent_browser_wait_for_selector',
  'agent_browser_wait_for_text',
  'agent_browser_wait_for_load',
  'agent_browser_get_text',
  'agent_browser_get_url',
  'agent_browser_get_title',
  'agent_browser_eval',
  'agent_browser_screenshot',
];

/** Only QA clicks, and only the basket icon (its guard checks the selector). */
const roleTools = (tools: readonly string[], click: string, role: BrowserRole) => (role === 'qa' ? [...tools, click] : [...tools]);

export interface BrowserMcpOptions {
  role: BrowserRole;
  connection: BrowserConnection;
  /** Directory for snapshots/screenshots this run produces. */
  outputDir: string;
  /** Network origins the agent's tab must never reach (checkout endpoints). Playwright only. */
  blockedOrigins: string[];
  /** agent-browser session name (one per task). */
  session: string;
}

export function browserToolset(kind: BrowserMcpKind, opts: BrowserMcpOptions): BrowserToolset {
  if (kind === 'playwright') {
    const serverName = 'playwright';
    const args = [
      path.join(pkgDir('@playwright/mcp'), 'cli.js'),
      ...playwrightConnectionArgs(opts.connection),
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
    if (opts.blockedOrigins.length) args.push('--blocked-origins', opts.blockedOrigins.join(';'));
    const env = minimalEnv();
    if (opts.connection.mode === 'extension' && opts.connection.token) env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = opts.connection.token;
    return {
      kind,
      serverName,
      server: { type: 'stdio', command: process.execPath, args, env },
      allowedTools: roleTools(PLAYWRIGHT_TOOLS, 'browser_click', opts.role).map((t) => `mcp__${serverName}__${t}`),
      evalTool: { name: `mcp__${serverName}__browser_evaluate`, codeField: 'function' },
      clickTool: { name: `mcp__${serverName}__browser_click`, selectorField: 'target' },
      startsInOwnTab: opts.connection.mode === 'extension',
      seesOnlyOwnTabs: opts.connection.mode === 'extension',
      tool: (t) => `mcp__${serverName}__${t}`,
      cleanup: async () => {}, // Playwright MCP leaves nothing running once its server exits
    };
  }

  if (opts.connection.mode !== 'cdp') {
    throw new Error('agent-browser connects over CDP only: use playwright for this agent, or BROWSER_MODE=cdp.');
  }
  const serverName = 'agent_browser';
  // The JS wrapper chmods the bundled native binary on first run; never call the binary directly.
  const cli = path.join(pkgDir('agent-browser'), 'bin', 'agent-browser.js');
  const env = {
    ...minimalEnv(),
    AGENT_BROWSER_CDP: cdpTarget(opts.connection.cdpUrl),
    AGENT_BROWSER_PIN_TAB: '1', // open our own tab, never drive the user's active tab
    AGENT_BROWSER_SESSION: opts.session,
    AGENT_BROWSER_SOCKET_DIR: AGENT_BROWSER_SOCKET_DIR,
    AGENT_BROWSER_SCREENSHOT_DIR: opts.outputDir,
  };
  return {
    kind,
    serverName,
    server: { type: 'stdio', command: process.execPath, args: [cli, 'mcp', '--tools', 'core'], env },
    allowedTools: roleTools(AGENT_BROWSER_TOOLS, 'agent_browser_click', opts.role).map((t) => `mcp__${serverName}__${t}`),
    evalTool: { name: `mcp__${serverName}__agent_browser_eval`, codeField: 'script' },
    clickTool: { name: `mcp__${serverName}__agent_browser_click`, selectorField: 'selector' },
    startsInOwnTab: true,
    seesOnlyOwnTabs: false, // attached over CDP: the daemon sees every tab of the browser
    tool: (t) => `mcp__${serverName}__${t}`,
    cleanup: () => closeAgentBrowserSession(cli, env, opts.session),
  };
}

/**
 * Extension mode: Playwright MCP finds the profile on disk and opens the extension's connect page in it (the user
 * approves the connection unless the server holds the extension's token).
 */
function playwrightConnectionArgs(connection: BrowserConnection): string[] {
  return connection.mode === 'extension'
    ? ['--extension', '--profile-dir-name', connection.profileDir]
    : ['--cdp-endpoint', connection.cdpUrl, '--cdp-timeout', '10000'];
}

/**
 * `close` stops the session's daemon and keeps the CDP-attached browser and the session's tab. It is sent
 * only to a live daemon: without one the CLI would start a daemon and open a new tab (agent-browser 0.38.2).
 * The daemon exits shortly after `close` returns.
 */
async function closeAgentBrowserSession(cli: string, env: Record<string, string>, session: string): Promise<void> {
  const socket = path.join(AGENT_BROWSER_SOCKET_DIR, `${session}.sock`);
  if (await acceptsConnections(socket)) {
    await execFileAsync(process.execPath, [cli, 'close'], { env, timeout: CLOSE_TIMEOUT_MS }).catch(() => undefined);
    const deadline = Date.now() + DAEMON_EXIT_MS;
    while (Date.now() < deadline && (await acceptsConnections(socket))) await delay(100);
  }
  const files = await readdir(AGENT_BROWSER_SOCKET_DIR).catch(() => [] as string[]);
  await Promise.all(
    files.filter((f) => f.startsWith(`${session}.`)).map((f) => rm(path.join(AGENT_BROWSER_SOCKET_DIR, f), { force: true }).catch(() => undefined)),
  );
}

function acceptsConnections(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const conn = net.connect(socketPath);
    conn.once('connect', () => {
      conn.destroy();
      resolve(true);
    });
    conn.once('error', () => resolve(false));
  });
}

/** agent-browser accepts a port for local CDP or a full URL. */
function cdpTarget(url: string): string {
  const u = new URL(url);
  return ['127.0.0.1', 'localhost'].includes(u.hostname) && u.port ? u.port : url;
}

/**
 * Secrets the browser servers (and the agent-browser daemon they start) must never hold. The extension token is
 * given back to the Playwright server that connects through the extension, and to nothing else.
 */
const SECRET_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_API_ROOT',
  'TELEGRAM_ALLOWED_USER_ID',
  'PLAYWRIGHT_MCP_EXTENSION_TOKEN',
];

/**
 * The CLI starts a stdio server with its own environment overlaid by this one (`{...cliEnv, ...server.env}`),
 * so leaving a variable out does not remove it: secrets are overridden with empty values.
 */
function minimalEnv(): Record<string, string> {
  const keep = ['PATH', 'HOME', 'USER', 'TMPDIR', 'LANG', 'LC_ALL'];
  const kept = Object.fromEntries(keep.flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : [])));
  return { ...Object.fromEntries(SECRET_KEYS.map((k) => [k, ''])), ...kept };
}

/**
 * What a browser tool call returned: the "### Result" value (Playwright MCP) or `response.data.result`
 * (agent-browser), JSON-parsed when possible, else the text. Accepts every shape seen in practice: a PostToolUse
 * `tool_response` (Playwright: content blocks; agent-browser: the JSON envelope as a string), the envelope as an
 * object, and an MCP CallToolResult (content blocks and/or structuredContent).
 */
export function toolResultValue(kind: BrowserMcpKind, response: unknown): unknown {
  const r = (response && typeof response === 'object' ? response : {}) as { content?: unknown; structuredContent?: unknown };
  const blocks: unknown[] = Array.isArray(response) ? response : Array.isArray(r.content) ? r.content : [];
  const text =
    typeof response === 'string'
      ? response
      : blocks
          .flatMap((b) => {
            const block = b as { type?: unknown; text?: unknown };
            return block.type === 'text' && typeof block.text === 'string' ? [block.text] : [];
          })
          .join('\n');
  if (kind === 'playwright') {
    const match = text.match(/### Result\s*\n([\s\S]*?)(?:\n### |$)/);
    return match ? parseJsonOr(match[1]!.trim()) : text;
  }
  for (const candidate of [r.structuredContent, Array.isArray(response) ? undefined : response, parseJsonOr(text)]) {
    const data = (candidate as { response?: { data?: unknown } } | null | undefined)?.response?.data;
    if (data && typeof data === 'object' && 'result' in data) return (data as { result: unknown }).result;
  }
  return parseJsonOr(text);
}

function parseJsonOr(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
