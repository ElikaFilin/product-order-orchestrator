import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { configProblems, parseCliJson, pluginProblems } from '../src/cli/openclaw-checks.js';
import { buildOpenClawConfig } from '../src/openclaw/config.js';
import { PLUGIN_TOOLS } from '../src/plugin/tools.js';

const REPO = '/repo';

describe('doctor: installed config', () => {
  const generated = buildOpenClawConfig({
    repoRoot: REPO,
    workspaceRoot: REPO,
    nodePath: '/node',
    telegramUserId: '42',
    browser: { mode: 'extension', profileDir: 'Default' },
    playwrightOutputDir: '/tmp/pw',
  }) as any;
  const installed = { entries: generated.agents.entries, bindings: generated.bindings, telegram: generated.channels.telegram };

  it('accepts what pnpm openclaw:config generates', () => {
    expect(configProblems(installed, REPO, 42)).toEqual([]);
  });

  it('reports a missing agent, a foreign workspace, a second Telegram owner and other users', () => {
    const problems = configProblems(
      {
        entries: { ...installed.entries, qa: undefined, explore: { workspace: path.join('/elsewhere', 'explore') } },
        bindings: [...installed.bindings, { agentId: 'main', match: { channel: 'telegram' } }],
        telegram: { ...installed.telegram, dmPolicy: 'pairing', allowFrom: ['tg:42', 'tg:7'] },
      },
      REPO,
      42,
    );
    expect(problems).toEqual([
      'agent explore uses workspace /elsewhere/explore',
      'agent qa is missing',
      'Telegram is bound to cos, main, not to cos alone',
      'Telegram dmPolicy is pairing, not allowlist',
      'Telegram allowFrom is not just your user id',
    ]);
  });
});

describe('doctor: loaded plugin', () => {
  const hooks = ['before_tool_call', 'before_prompt_build', 'message_sending', 'subagent_spawned', 'subagent_ended', 'before_reset'].map((name) => ({ name }));

  it('accepts a loaded plugin with every tool and hook', () => {
    expect(pluginProblems({ plugin: { status: 'loaded' }, tools: [{ names: [...PLUGIN_TOOLS] }], typedHooks: hooks })).toEqual([]);
  });

  it('reports what is missing', () => {
    expect(pluginProblems({ plugin: { status: 'error' }, tools: [{ names: ['poo_task'] }], typedHooks: hooks.slice(1) })).toEqual([
      'status error',
      `tools missing: ${PLUGIN_TOOLS.filter((t) => t !== 'poo_task').join(', ')}`,
      'hook before_tool_call not registered',
    ]);
  });

  it('reads JSON after a CLI banner line', () => {
    expect(parseCliJson('OpenClaw 2026.9.9 (bcfc888) — All your chats\n{"valid":true}')).toEqual({ valid: true });
    expect(parseCliJson('no json here')).toBeUndefined();
  });
});
