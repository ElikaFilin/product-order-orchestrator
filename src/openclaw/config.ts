/**
 * The OpenClaw configuration of this project: the four agents, Telegram owned by COS, the Playwright MCP server, the
 * plugin and the safety settings. Paths are absolute; secrets appear only as `${VAR}` (the gateway process gets them
 * from the repo's .env). `buildLocalConfig` is the gateway `pnpm start` runs; `buildE2eConfig` is an isolated
 * gateway that talks to local mocks.
 */
import path from 'node:path';
import type { BrowserConnection } from '../browser/connection.js';
import { playwrightMcpArgs, playwrightMcpCli } from '../browser/playwright-mcp.js';
import { SUB_AGENTS, type AgentName } from '../core/agents.js';
import { EXECUTE_BROWSER_TOOLS, OPENCLAW_TOOL_PREFIX, PLAYWRIGHT_SERVER, QA_BROWSER_TOOLS } from '../core/browser/toolset.js';
import { SKILL_NAME, skillFile } from '../core/explore/product-list.js';
import { listShops } from '../core/shops/index.js';
import { PLUGIN_ID } from '../plugin/config.js';
import { COS_TOOLS, CHILD_TOOLS } from '../plugin/tools.js';

export const MODELS = { cos: 'anthropic/claude-opus-5-5', subagents: 'anthropic/claude-sonnet-5-5' } as const;
export const RUN_TIMEOUT_SECONDS = { explore: 300, execute: 900, qa: 600 } as const;

export interface OpenClawConfigOptions {
  /** The repository: plugin bundle and @playwright/mcp. */
  repoRoot: string;
  /** Holds the agent workspaces `agents/<id>/` (the repo, or a copy of it in tests). */
  workspaceRoot: string;
  /** Node binary that runs Playwright MCP (Node 24). */
  nodePath: string;
  telegramUserId: string;
  browser: BrowserConnection;
  /** Where the basket link must be opened, as COS tells the user. */
  basketBrowser?: string;
  /** Snapshots and screenshots of the browser tools. */
  playwrightOutputDir: string;
  /** The plugin's order and task state (default: under OPENCLAW_STATE_DIR). */
  stateFile?: string;
  /** Model refs, when a test serves other ids. */
  models?: { cos: string; subagents: string };
}

/** A standalone gateway for the e2e: its own port and token, the mock Anthropic API and the fake Bot API. */
export interface E2eGatewayOptions {
  port: number;
  token: string;
  anthropicBaseUrl: string;
  telegramApiRoot: string;
  /** Model ids the mock answers for (without the provider prefix). */
  modelIds: string[];
}

const childTools = (agent: (typeof SUB_AGENTS)[number]) =>
  Object.entries(CHILD_TOOLS)
    .filter(([, agents]) => (agents as readonly string[]).includes(agent))
    .map(([name]) => name);
const browser = (tools: readonly string[]) => tools.map((t) => `${OPENCLAW_TOOL_PREFIX}${t}`);

/** Each agent's explicit tool allow-list. COS holds the union: its tools are the ceiling of its children's. */
export function agentAllowLists(): Record<AgentName, string[]> {
  const lists = {
    explore: ['read', ...childTools('explore')],
    execute: [...browser(EXECUTE_BROWSER_TOOLS), ...childTools('execute')],
    qa: [...browser(QA_BROWSER_TOOLS), ...childTools('qa')],
  };
  const cos = ['message', 'sessions_spawn', 'sessions_yield', 'sessions_send', 'subagents', ...COS_TOOLS];
  return { cos: [...new Set([...cos, ...lists.explore, ...lists.execute, ...lists.qa])], ...lists };
}

export function buildOpenClawConfig(o: OpenClawConfigOptions): Record<string, unknown> {
  const workspace = (id: AgentName) => path.join(o.workspaceRoot, 'agents', id);
  const allow = agentAllowLists();
  const models = o.models ?? MODELS;
  const sub = (id: (typeof SUB_AGENTS)[number], extra: Record<string, unknown> = {}) => ({
    name: id[0]!.toUpperCase() + id.slice(1),
    workspace: workspace(id),
    model: models.subagents,
    skills: [],
    tools: { allow: allow[id] },
    ...extra,
  });
  const blockedOrigins = listShops().flatMap((s) => s.blockedOrigins);

  return {
    agents: {
      ownership: 'explicit',
      defaults: {
        // The workspaces are the repo's agents/<id>/ folders; no persona files or first-run ritual.
        skipBootstrap: true,
        heartbeat: { every: '0m' },
        subagents: { maxSpawnDepth: 1, archiveAfterMinutes: 0, runTimeoutSeconds: RUN_TIMEOUT_SECONDS.execute },
      },
      entries: {
        cos: {
          name: 'COS',
          description: 'Chief of Staff: the only agent that talks to the user (Telegram).',
          workspace: workspace('cos'),
          model: models.cos,
          skills: [],
          tools: { allow: allow.cos },
          subagents: { allowAgents: [...SUB_AGENTS], requireAgentId: true },
        },
        // Explore never starts the browser server (a deny on its namespace keeps the session from connecting it).
        explore: sub('explore', { skills: [SKILL_NAME], tools: { allow: allow.explore, deny: [`${OPENCLAW_TOOL_PREFIX}*`] } }),
        execute: sub('execute'),
        qa: sub('qa'),
      },
    },
    bindings: [{ agentId: 'cos', match: { channel: 'telegram', accountId: 'default' } }],
    channels: {
      telegram: {
        enabled: true,
        dmPolicy: 'allowlist',
        allowFrom: [`tg:${o.telegramUserId}`],
        streaming: { mode: 'off' },
      },
    },
    // COS talks only through the message tool; its plain text stays private.
    messages: { visibleReplies: 'message_tool', queue: { byChannel: { telegram: 'followup' } } },
    tools: { sessions: { visibility: 'tree' }, agentToAgent: { enabled: false }, codeMode: false, toolSearch: false },
    skills: { workshop: { autonomous: { mode: 'off' } } },
    talk: { agentId: 'cos' },
    mcp: {
      servers: {
        [PLAYWRIGHT_SERVER]: {
          command: o.nodePath,
          args: [playwrightMcpCli(), ...playwrightMcpArgs({ connection: o.browser, outputDir: o.playwrightOutputDir, blockedOrigins })],
          ...(o.browser.mode === 'extension' ? { env: { PLAYWRIGHT_MCP_EXTENSION_TOKEN: '${PLAYWRIGHT_MCP_EXTENSION_TOKEN}' } } : {}),
          toolFilter: { include: [...QA_BROWSER_TOOLS] },
        },
      },
    },
    plugins: {
      load: { paths: [path.join(o.repoRoot, 'openclaw', 'plugin')] },
      entries: {
        // The built-in browser plugin can drive the real Chrome profile: Playwright MCP is the only browser.
        browser: { enabled: false },
        'memory-core': { config: { dreaming: { enabled: false } } },
        [PLUGIN_ID]: {
          enabled: true,
          hooks: { allowConversationAccess: true, allowPromptInjection: true },
          config: {
            skillFile: skillFile(o.workspaceRoot),
            telegramUserId: o.telegramUserId,
            browserMode: o.browser.mode,
            browserToolPrefix: OPENCLAW_TOOL_PREFIX,
            runTimeoutSeconds: RUN_TIMEOUT_SECONDS,
            ...(o.basketBrowser ? { basketBrowser: o.basketBrowser } : {}),
            ...(o.stateFile ? { stateFile: o.stateFile } : {}),
          },
        },
      },
    },
  };
}

/** The project's gateway: loopback only, token auth (`${OPENCLAW_GATEWAY_TOKEN}`), no update checks, no LAN discovery. */
export function buildLocalConfig(o: OpenClawConfigOptions, port: number): Record<string, unknown> {
  return {
    gateway: { mode: 'local', port, bind: 'loopback', auth: { mode: 'token', token: '${OPENCLAW_GATEWAY_TOKEN}' } },
    update: { checkOnStart: false },
    discovery: { mdns: { mode: 'off' } },
    ...buildOpenClawConfig(o),
  };
}

/** The e2e gateway: our config plus a local gateway, mocks for Anthropic and Telegram, and nothing that goes online. */
export function buildE2eConfig(o: OpenClawConfigOptions, g: E2eGatewayOptions): Record<string, unknown> {
  const base = buildOpenClawConfig(o) as Record<string, any>;
  base.agents.defaults.typingMode = 'never';
  base.channels.telegram = { ...base.channels.telegram, apiRoot: g.telegramApiRoot, commands: { native: false } };
  return {
    gateway: { mode: 'local', port: g.port, bind: 'loopback', auth: { mode: 'token', token: g.token } },
    update: { checkOnStart: false },
    telemetry: { enabled: false },
    discovery: { mdns: { mode: 'off' } },
    cron: { enabled: false },
    memory: { search: { provider: 'none' } },
    models: {
      mode: 'replace',
      catalogRefresh: { enabled: false },
      providers: {
        anthropic: {
          baseUrl: g.anthropicBaseUrl,
          api: 'anthropic-messages',
          models: g.modelIds.map((id) => ({ id, name: id, input: ['text'], contextWindow: 200_000, maxTokens: 8192 })),
        },
      },
    },
    ...base,
  };
}
