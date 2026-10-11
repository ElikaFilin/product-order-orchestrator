import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { karashynyard } from '../src/core/shops/karashynyard/index.js';
import { agentAllowLists, buildE2eConfig, buildLocalConfig, buildOpenClawConfig, type OpenClawConfigOptions } from '../src/openclaw/config.js';
import { parsePluginConfig } from '../src/plugin/config.js';
import { agentTools } from '../src/plugin/hooks.js';
import { createRuntime } from '../src/plugin/runtime.js';

const REPO = '/repo';
const options = (browser: OpenClawConfigOptions['browser']): OpenClawConfigOptions => ({
  repoRoot: REPO,
  workspaceRoot: REPO,
  nodePath: '/node/v24/bin/node',
  telegramUserId: '111222333',
  browser,
  playwrightOutputDir: '/repo/.runtime/playwright',
});
const extension = buildOpenClawConfig(options({ mode: 'extension', profileDir: 'Default', token: 'real-token-must-not-appear' })) as any;

describe('OpenClaw config', () => {
  it('holds no secrets: the extension token is a ${VAR} reference', () => {
    const json = JSON.stringify(extension);
    expect(json).not.toContain('real-token-must-not-appear');
    expect(extension.mcp.servers.playwright.env).toEqual({ PLAYWRIGHT_MCP_EXTENSION_TOKEN: '${PLAYWRIGHT_MCP_EXTENSION_TOKEN}' });
    expect(json).not.toMatch(/botToken|apiKey/);
  });

  it('gives Telegram to COS alone, for the owner only', () => {
    expect(extension.bindings).toEqual([{ agentId: 'cos', match: { channel: 'telegram', accountId: 'default' } }]);
    expect(extension.channels.telegram).toMatchObject({ dmPolicy: 'allowlist', allowFrom: ['tg:111222333'] });
    expect(extension.messages).toEqual({ visibleReplies: 'message_tool', queue: { byChannel: { telegram: 'followup' } } });
  });

  it('lets only COS spawn, one level deep, with no agent-to-agent messaging', () => {
    const { entries, defaults } = extension.agents;
    expect(extension.agents.ownership).toBe('explicit');
    expect(defaults.subagents).toMatchObject({ maxSpawnDepth: 1, archiveAfterMinutes: 0 });
    expect(entries.cos.subagents.allowAgents).toEqual(['explore', 'execute', 'qa']);
    for (const id of ['explore', 'execute', 'qa']) expect(entries[id].subagents).toBeUndefined();
    expect(extension.tools).toEqual({ sessions: { visibility: 'tree' }, agentToAgent: { enabled: false }, codeMode: false, toolSearch: false });
    expect(entries.cos.model).toBe('anthropic/claude-opus-5-5');
    expect(defaults.model).toBe('anthropic/claude-opus-5-5');
    expect(entries.qa.model).toBe('anthropic/claude-sonnet-5-5');
  });

  it("gives COS the union of its children's tools (their ceiling) and each child only its own", () => {
    const lists = agentAllowLists();
    for (const child of ['explore', 'execute', 'qa'] as const) for (const tool of lists[child]) expect(lists.cos).toContain(tool);
    expect(lists.execute).not.toContain('playwright__browser_click');
    expect(lists.qa).toContain('playwright__browser_click');
    expect(lists.explore).toEqual(['read', 'poo_ask_user', 'poo_update_product_list', 'poo_submit_selection']);
    expect(extension.agents.entries.explore.tools.deny).toEqual(['playwright__*']);
    expect(extension.agents.entries.explore.skills).toEqual(['ask-what-to-buy']);
  });

  it("matches the plugin's own per-agent tool policy", () => {
    const rt = createRuntime(parsePluginConfig({ skillFile: '/x/SKILL.md', telegramUserId: 1, stateFile: '/tmp/poo-unused.json' }), console);
    const policy = agentTools(rt);
    const lists = agentAllowLists();
    for (const id of ['explore', 'execute', 'qa'] as const) expect([...policy[id]].sort()).toEqual([...lists[id]].sort());
    for (const tool of policy.cos) expect(lists.cos).toContain(tool);
  });

  it('runs the repo Playwright MCP through the extension, blocking the checkout origins, with only the agents tools', () => {
    const server = extension.mcp.servers.playwright;
    expect(server.command).toBe('/node/v24/bin/node');
    expect(server.args[0]).toMatch(/@playwright[/\\]mcp[/\\]cli\.js$/);
    expect(server.args).toEqual(expect.arrayContaining(['--extension', '--profile-dir-name', 'Default', '--blocked-origins']));
    expect(server.args[server.args.indexOf('--blocked-origins') + 1].split(';')).toEqual(karashynyard.blockedOrigins);
    expect(server.toolFilter.include).toContain('browser_click');
    expect(server.toolFilter.include).not.toContain('browser_run_code_unsafe');
  });

  it('loads our plugin with a valid config, and disables the built-in browser and dreaming', () => {
    const { load, entries } = extension.plugins;
    expect(load.paths).toEqual([path.join(REPO, 'openclaw', 'plugin')]);
    expect(entries.browser).toEqual({ enabled: false });
    expect(entries['memory-core']).toEqual({ config: { dreaming: { enabled: false } } });
    const plugin = entries['product-order-orchestrator'];
    expect(plugin.hooks).toEqual({ allowConversationAccess: true, allowPromptInjection: true });
    expect(parsePluginConfig(plugin.config)).toMatchObject({
      skillFile: path.join(REPO, 'agents/explore/skills/ask-what-to-buy/SKILL.md'),
      telegramUserId: '111222333',
      browserMode: 'extension',
    });
    expect(extension.skills).toEqual({ workshop: { autonomous: { mode: 'off' } } });
    expect(extension.agents.defaults.skipBootstrap).toBe(true);
  });

  it("gives COS its memory: MEMORY.md tools inside its workspace, owner turns, keyword search, no automatic notes", () => {
    const cos = extension.agents.entries.cos;
    expect(cos.tools.allow).toEqual(expect.arrayContaining(['read', 'write', 'edit', 'memory_search', 'memory_get']));
    expect(cos.tools.fs).toEqual({ workspaceOnly: true });
    for (const child of ['explore', 'execute', 'qa']) expect(extension.agents.entries[child].tools.allow).not.toContain('write');
    expect(extension.commands).toEqual({ ownerAllowFrom: ['telegram:111222333'] });
    expect(extension.memory).toEqual({ search: { provider: 'none' } });
    expect(extension.agents.defaults.compaction).toEqual({ memoryFlush: { enabled: false } });
    expect(parsePluginConfig(extension.plugins.entries['product-order-orchestrator'].config).memoryFile).toBe(path.join(REPO, 'agents/cos/MEMORY.md'));
  });

  it('passes the order form details to the plugin only when they are set', () => {
    const checkout = { name: 'Тарас Тестовий', phone: '+380671234567', delivery: 'Доставка Новою поштою', address: 'вул. Тестова 1, Київ' };
    const withForm = buildOpenClawConfig({ ...options({ mode: 'extension', profileDir: 'Default' }), checkout }) as any;
    expect(parsePluginConfig(withForm.plugins.entries['product-order-orchestrator'].config).checkout).toEqual(checkout);
    expect(extension.plugins.entries['product-order-orchestrator'].config).not.toHaveProperty('checkout');
  });

  it("local: the project's gateway on loopback with token auth from the environment, no update checks or LAN discovery", () => {
    const local = buildLocalConfig(options({ mode: 'extension', profileDir: 'Default' }), 18789) as any;
    expect(local.gateway).toEqual({ mode: 'local', port: 18789, bind: 'loopback', auth: { mode: 'token', token: '${OPENCLAW_GATEWAY_TOKEN}' } });
    expect(local.update).toEqual({ checkOnStart: false });
    expect(local.discovery).toEqual({ mdns: { mode: 'off' } });
    expect(local.agents).toEqual(extension.agents);
  });

  it('e2e: an isolated offline gateway over CDP with the mocks', () => {
    const e2e = buildE2eConfig(options({ mode: 'cdp', cdpUrl: 'http://127.0.0.1:9555' }), {
      port: 19400,
      token: 'test-token',
      anthropicBaseUrl: 'http://127.0.0.1:9556',
      telegramApiRoot: 'http://127.0.0.1:9557',
      modelIds: ['claude-opus-5-5'],
    }) as any;
    expect(e2e.gateway).toMatchObject({ mode: 'local', port: 19400, bind: 'loopback' });
    expect(e2e.models).toMatchObject({ mode: 'replace', providers: { anthropic: { baseUrl: 'http://127.0.0.1:9556' } } });
    expect(e2e.channels.telegram.apiRoot).toBe('http://127.0.0.1:9557');
    expect(e2e.update).toEqual({ checkOnStart: false });
    expect(e2e.mcp.servers.playwright.args).toEqual(expect.arrayContaining(['--cdp-endpoint', 'http://127.0.0.1:9555']));
    expect(e2e.mcp.servers.playwright.env).toBeUndefined();
  });
});
