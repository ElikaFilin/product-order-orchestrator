import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ROOT_DIR } from '../../src/config/env.js';
import { skillFile } from '../../src/core/explore/product-list.js';
import { MEMORY_TEMPLATE } from '../../src/core/memory.js';
import { karashynyard } from '../../src/core/shops/karashynyard/index.js';
import { parsePluginConfig, PluginConfig } from '../../src/plugin/config.js';
import { setupPlugin } from '../../src/plugin/plugin.js';
import { createRuntime, type Runtime } from '../../src/plugin/runtime.js';
import { PLUGIN_TOOLS } from '../../src/plugin/tools.js';
import { child, COS, FakeHost, textResult } from './fake-host.js';

const PW = 'playwright__';
let dir: string;
let host: FakeHost;
let rt: Runtime;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'poo-policy-'));
  const skill = skillFile(dir);
  await mkdir(path.dirname(skill), { recursive: true });
  await copyFile(skillFile(ROOT_DIR), skill);
  host = new FakeHost();
  const config = parsePluginConfig({ skillFile: skill, telegramUserId: 4242, stateFile: path.join(dir, 'state.json') });
  rt = setupPlugin(host, createRuntime(config, host.logger));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const blocked = async (tool: string, params: Record<string, unknown>, ctx: Record<string, string>) => (await host.before(tool, params, ctx)).blockReason;

describe('tool policy', () => {
  it.each([
    ['cos', `${PW}browser_navigate`],
    ['cos', 'poo_submit_qa'],
    ['cos', 'exec'],
    ['explore', 'message'],
    ['explore', `${PW}browser_snapshot`],
    ['explore', 'sessions_spawn'],
    ['execute', `${PW}browser_click`],
    ['execute', 'poo_submit_qa'],
    ['qa', 'poo_submit_execute'],
    ['qa', `${PW}browser_run_code_unsafe`],
  ])('%s may not call %s', async (agentId, tool) => {
    expect(await blocked(tool, {}, { agentId, sessionKey: `agent:${agentId}:x` })).toMatch(/not available/);
  });

  it('leaves agents of other teams alone', async () => {
    expect(await blocked('exec', { command: 'ls' }, { agentId: 'main', sessionKey: 'agent:main:main' })).toBeUndefined();
  });

  it('offers COS every plugin tool (its tools are the ceiling of its children) and each child only its own', () => {
    expect(host.toolNames({ agentId: 'cos' }).sort()).toEqual([...PLUGIN_TOOLS].sort());
    expect(host.toolNames({ agentId: 'explore' }).sort()).toEqual(['poo_ask_user', 'poo_submit_selection', 'poo_update_product_list']);
    expect(host.toolNames({ agentId: 'qa' }).sort()).toEqual(['poo_ask_user', 'poo_submit_qa']);
  });

  it('narrows every turn of our agents to their tools', async () => {
    expect((await host.promptBuild(COS))?.toolsAllow).toEqual(expect.arrayContaining(['message', 'sessions_spawn', 'poo_task']));
    expect((await host.promptBuild(COS))?.toolsAllow).not.toContain(`${PW}browser_navigate`);
    expect((await host.promptBuild(child('qa')))?.toolsAllow).toContain(`${PW}browser_click`);
    expect((await host.promptBuild(child('qa')))?.appendContext).toBeUndefined();
    expect(await host.promptBuild({ agentId: 'main' })).toBeUndefined();
  });

  it('gives children their tools only while their task runs', async () => {
    await expect(host.tool('poo_ask_user', { question: '?' }, child('explore'))).rejects.toThrow(/no task/);
    expect(await blocked(`${PW}browser_tabs`, { action: 'new', url: karashynyard.baseUrl }, child('execute'))).toMatch(/running Execute or QA task/);
  });
});

describe('workspace files in the prompts', () => {
  const files = [
    { name: 'AGENTS.md', path: '/w/AGENTS.md', content: '# COS', missing: false },
    { name: 'SOUL.md', path: '/w/SOUL.md', missing: true },
    { name: 'IDENTITY.md', path: '/w/IDENTITY.md', missing: true },
    { name: 'MEMORY.md', path: '/w/MEMORY.md', content: '# Memory', missing: false },
  ];

  it('leaves missing files (no "[MISSING]" lines) out of our agents\' prompts', async () => {
    const context = await host.internal('agent', 'bootstrap', 'agent:cos:main', { agentId: 'cos', bootstrapFiles: files });
    expect((context.bootstrapFiles as typeof files).map((f) => f.name)).toEqual(['AGENTS.md', 'MEMORY.md']);
  });

  it('leaves agents of other teams alone', async () => {
    const context = await host.internal('agent', 'bootstrap', 'agent:main:main', { agentId: 'main', bootstrapFiles: files });
    expect(context.bootstrapFiles).toBe(files);
  });
});

describe('Explore reads only its skill', () => {
  it('allows the skill file, relative to its workspace or absolute', async () => {
    for (const p of ['skills/ask-what-to-buy/SKILL.md', './skills/ask-what-to-buy/SKILL.md', rt.config.skillFile]) {
      expect(await blocked('read', { path: p }, child('explore')), p).toBeUndefined();
    }
  });

  it.each(['/etc/passwd', '../../.env', 'AGENTS.md', 'skills/ask-what-to-buy/../../AGENTS.md', ''])('denies %s', async (p) => {
    expect(await blocked('read', { path: p }, child('explore'))).toMatch(/Only your skill file/);
  });
});

describe("COS's memory file", () => {
  const memory = () => path.join(dir, 'agents', 'cos', 'MEMORY.md');
  const withMemory = () => {
    host = new FakeHost();
    const config = parsePluginConfig({ skillFile: skillFile(dir), memoryFile: memory(), telegramUserId: 4242, stateFile: path.join(dir, 'state.json') });
    rt = setupPlugin(host, createRuntime(config, host.logger));
  };

  it('is created from the template on start, and never overwritten', async () => {
    withMemory();
    expect(await readFile(memory(), 'utf8')).toBe(MEMORY_TEMPLATE);
    await writeFile(memory(), '# Memory\n\n## Every order\n\n- X × 1\n');
    withMemory();
    expect(await readFile(memory(), 'utf8')).toContain('- X × 1');
  });

  it('COS reads, writes and edits MEMORY.md, relative to its workspace or absolute', async () => {
    withMemory();
    for (const tool of ['read', 'write', 'edit']) {
      for (const p of ['MEMORY.md', './MEMORY.md', memory()]) expect(await blocked(tool, { path: p }, COS), `${tool} ${p}`).toBeUndefined();
    }
    expect(await blocked('edit', { file_path: 'MEMORY.md' }, COS)).toBeUndefined();
    expect((await host.promptBuild(COS))?.toolsAllow).toEqual(expect.arrayContaining(['read', 'write', 'edit', 'memory_search', 'memory_get']));
  });

  it.each(['AGENTS.md', '../explore/skills/ask-what-to-buy/SKILL.md', 'memory/2026-10-11.md', '/etc/passwd', '../../../.env', ''])('COS may not touch %s', async (p) => {
    withMemory();
    for (const tool of ['read', 'write', 'edit']) expect(await blocked(tool, { path: p }, COS)).toMatch(/Only your memory file/);
  });

  it('only COS has it: children cannot write or search it, and Explore cannot read it', async () => {
    withMemory();
    expect(await blocked('write', { path: 'MEMORY.md' }, child('explore'))).toMatch(/not available/);
    expect(await blocked('memory_search', { query: 'x' }, child('qa'))).toMatch(/not available/);
    expect(await blocked('read', { path: memory() }, child('explore'))).toMatch(/Only your skill file/);
  });

  it('without a memory file configured, COS file calls are refused', async () => {
    expect(await blocked('write', { path: 'MEMORY.md' }, COS)).toMatch(/No memory file/);
  });
});

describe("COS's messages", () => {
  it.each([
    [{ action: 'react', emoji: '👍' }, /Only action "send"/],
    [{ action: 'send', message: 'hi', target: 'telegram:1' }, /only to the user's chat/],
    [{ action: 'send', message: 'hi', channel: 'slack' }, /Telegram chat/],
    [{ action: 'send', message: 'hi', media: '/etc/passwd' }, /remove media/],
    [{ action: 'send', message: '  ' }, /empty/],
  ])('denies %j', async (params, reason) => {
    expect(await blocked('message', params, COS)).toMatch(reason);
  });

  it('sends plain text to the owner, with or without an explicit target', async () => {
    for (const target of [undefined, '4242', 'telegram:4242', 'tg:4242']) {
      const r = await host.before('message', { action: 'send', text: 'Привіт', ...(target ? { target } : {}) }, COS);
      expect(r.params).toEqual({ action: 'send', message: 'Привіт' });
    }
  });

  it('cancels outgoing Telegram messages to anyone else, and the basket link before verification', async () => {
    expect(await host.emit('message_sending', { to: 'telegram:1', content: 'hi' }, { channelId: 'telegram' })).toEqual([{ cancel: true, cancelReason: 'only the owner chat' }]);
    expect(await host.emit('message_sending', { to: 'telegram:4242', content: `go ${karashynyard.cartUrl}` }, { channelId: 'telegram' })).toEqual([
      { cancel: true, cancelReason: 'basket not verified' },
    ]);
    expect(await host.emit('message_sending', { to: 'telegram:4242', content: 'hi' }, { channelId: 'telegram' })).toEqual([undefined]);
    expect(await host.emit('message_sending', { to: 'webchat:x', content: 'hi' }, { channelId: 'webchat' })).toEqual([undefined]);
  });
});

describe('sessions_spawn', () => {
  it('starts only tasks COS created, on their own agent, once', async () => {
    expect(await blocked('sessions_spawn', { agentId: 'explore', task: 'Ask the user what to buy' }, COS)).toMatch(/poo_task first/);
    const task = await host.tool('poo_task', { agent: 'explore', instruction: '' }, COS);
    expect(await blocked('sessions_spawn', { agentId: 'execute', task: task.taskId }, COS)).toMatch(/agentId "explore"/);
    const ok = await host.before('sessions_spawn', { agentId: 'explore', task: task.taskId, model: 'anthropic/claude-opus-5-5', visible: true }, COS);
    expect(ok.params).not.toHaveProperty('model');
    expect(ok.params).not.toHaveProperty('visible');
    const c = child('explore');
    await host.result('sessions_spawn', ok.params!, textResult(JSON.stringify({ childSessionKey: c.sessionKey, runId: c.runId })), COS, ok.toolCallId);
    expect(await blocked('sessions_spawn', { agentId: 'explore', task: task.taskId }, COS)).toMatch(/is running/);
  });
});

describe('browser results', () => {
  it("hide the user's other tabs before the model sees them", async () => {
    rt.store.update(() => rt.store.order.applySelection({ type: 'selection', shopId: 'karashynyard', items: [{ name: 'X', qty: 1 }] }));
    const task = await host.tool('poo_task', { agent: 'execute', instruction: '' }, COS);
    const spawn = await host.before('sessions_spawn', { agentId: 'execute', task: task.taskId }, COS);
    const c = child('execute');
    await host.emit('subagent_spawned', { childSessionKey: c.sessionKey, agentId: 'execute', label: String(spawn.params!.label), runId: c.runId }, {});
    const tabs = '### Open tabs\n- 0: [Inbox](https://mail.example.com/u/0)\n- 1: (current) [Shop](https://karashynyard.com.ua/)';
    const call = await host.before(`${PW}browser_navigate`, { url: karashynyard.baseUrl }, c);
    const seen = await host.result(`${PW}browser_navigate`, call.params ?? {}, textResult(tabs), c, call.toolCallId);
    expect((seen.content[0] as { text: string }).text).not.toContain('mail.example.com');
    expect((seen.content[0] as { text: string }).text).toContain('[another tab, hidden]');
  });
});

describe('plugin manifest', () => {
  it('declares every tool and mirrors the config schema', async () => {
    const manifest = JSON.parse(await readFile(path.join(ROOT_DIR, 'openclaw/plugin/openclaw.plugin.json'), 'utf8'));
    expect(manifest.id).toBe('product-order-orchestrator');
    expect([...manifest.contracts.tools].sort()).toEqual([...PLUGIN_TOOLS].sort());
    expect(manifest.contracts.agentToolResultMiddleware).toEqual(['openclaw']);
    expect(Object.keys(manifest.configSchema.properties).sort()).toEqual(Object.keys(PluginConfig.shape).sort());
  });
});
