/**
 * Shared Agent SDK options (src/shared/claude.ts): what the Claude Code CLI accepts as an output schema,
 * the child process environment, and the PreToolUse guard hook.
 */
import type { PostToolUseHookInput, PreToolUseHookInput, SDKMessage, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { QaObservation } from '../src/agents/qa/report.js';
import { runtimeDir } from '../src/config/env.js';
import { Telemetry } from '../src/observability/telemetry.js';
import { deriveAgents } from '../src/observability/hub/state.js';
import type { ObsEvent } from '../src/observability/events.js';
import { agentProcessEnv, buildAgentOptions, SdkObserver, STRUCTURED_OUTPUT_TOOL, type AgentOptionsInput, type ToolGuard } from '../src/shared/claude.js';
import { ExecuteResult } from '../src/shared/contracts.js';

function optionsFor(outputSchema: z.ZodType, guard?: ToolGuard, extra: Partial<AgentOptionsInput> = {}) {
  return buildAgentOptions({
    agent: 'qa',
    model: 'test-model',
    cwd: '/tmp',
    systemPrompt: 'test',
    mcpServers: {},
    allowedTools: ['mcp__agent__ask_user'],
    ...(guard ? { guard } : {}),
    outputSchema,
    maxTurns: 1,
    maxBudgetUsd: 0.1,
    telemetry: new Telemetry('qa'),
    ...extra,
  });
}

const base = { session_id: 's', transcript_path: '/tmp/t', cwd: '/tmp' };

async function preToolUse(guard: ToolGuard, toolName: string): Promise<SyncHookJSONOutput> {
  const hook = optionsFor(QaObservation, guard).hooks?.PreToolUse?.[0]?.hooks[0];
  if (!hook) throw new Error('no PreToolUse hook');
  const input: PreToolUseHookInput = {
    hook_event_name: 'PreToolUse',
    session_id: 's',
    transcript_path: '/tmp/t',
    cwd: '/tmp',
    tool_name: toolName,
    tool_input: {},
    tool_use_id: `use-${toolName}`,
  };
  return (await hook(input, input.tool_use_id, { signal: new AbortController().signal })) as SyncHookJSONOutput;
}

describe('buildAgentOptions', () => {
  afterEach(() => {
    delete process.env.CLAUDE_CODE_SOME_INHERITED_FLAG;
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  it('passes the CLI an object-rooted JSON schema without the draft-2020-12 $schema it rejects', () => {
    for (const schema of [ExecuteResult, QaObservation, z.object({ notes: z.string().optional() })]) {
      const format = optionsFor(schema).outputFormat as { type: string; schema: Record<string, unknown> };
      expect(format.type).toBe('json_schema');
      expect(format.schema).not.toHaveProperty('$schema');
      expect(format.schema.type).toBe('object');
      expect(format.schema).toHaveProperty('properties');
    }
  });

  it('runs the CLI with its own config dir and without any CLAUDE.md or auto memory', () => {
    process.env.CLAUDE_CODE_SOME_INHERITED_FLAG = '1';
    const childEnv = agentProcessEnv();
    expect(childEnv.CLAUDE_CONFIG_DIR).toBe(runtimeDir('claude'));
    expect(childEnv.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe('1');
    expect(childEnv.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
    expect(childEnv).not.toHaveProperty('CLAUDE_CODE_SOME_INHERITED_FLAG');
  });

  it('keeps the Telegram bot token out of every agent CLI', () => {
    process.env.TELEGRAM_BOT_TOKEN = '123:fake';
    expect(agentProcessEnv()).not.toHaveProperty('TELEGRAM_BOT_TOKEN');
  });

  it('never runs inline shell from skills and keeps no session transcripts', () => {
    const options = optionsFor(QaObservation);
    expect(options.settings).toMatchObject({ disableBundledSkills: true, disableSkillShellExecution: true });
    expect(options.persistSession).toBe(false);
  });

  it("hands observers the agent's own input and the raw response, and redacts what everyone else sees", async () => {
    const seen: Array<{ tool: string; input: Record<string, unknown>; response: unknown }> = [];
    const telemetry = new Telemetry('qa');
    const emit = vi.spyOn(telemetry, 'emit');
    const options = optionsFor(QaObservation, (_tool, input) => ({ updatedInput: { ...input, code: `HELPER;${String(input.code)}` } }), {
      telemetry,
      onToolResult: (tool, input, response) => void seen.push({ tool, input, response }),
      redactOutput: (_tool, response) => (JSON.stringify(response).includes('secret tab') ? [{ type: 'text', text: '[hidden]' }] : undefined),
    });
    const pre = options.hooks?.PreToolUse?.[0]?.hooks[0];
    const post = options.hooks?.PostToolUse?.[0]?.hooks[0];
    if (!pre || !post) throw new Error('missing hooks');
    const signal = new AbortController().signal;
    const preInput: PreToolUseHookInput = { ...base, hook_event_name: 'PreToolUse', tool_name: 'mcp__x__eval', tool_input: { code: 'a()' }, tool_use_id: 'u1' };
    await pre(preInput, 'u1', { signal });
    const response = [{ type: 'text', text: '### Open tabs\n- 0: [secret tab](https://mail.example.com/)' }];
    const postInput: PostToolUseHookInput = {
      ...base,
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__x__eval',
      tool_input: { code: 'HELPER;a()' },
      tool_response: response,
      tool_use_id: 'u1',
    };
    const out = (await post(postInput, 'u1', { signal })) as SyncHookJSONOutput;

    expect(seen).toEqual([{ tool: 'mcp__x__eval', input: { code: 'a()' }, response }]);
    expect(out.hookSpecificOutput).toEqual({ hookEventName: 'PostToolUse', updatedToolOutput: [{ type: 'text', text: '[hidden]' }] });
    const result = emit.mock.calls.find(([kind]) => kind === 'tool_result')?.[1];
    expect(String(result?.output)).not.toContain('secret tab');
  });

  it('never lets a guard block the StructuredOutput tool that carries the final answer', async () => {
    const denyAll: ToolGuard = (tool) => ({ deny: `${tool} denied` });
    const structured = await preToolUse(denyAll, STRUCTURED_OUTPUT_TOOL);
    expect(structured.hookSpecificOutput).toBeUndefined();
    const other = await preToolUse(denyAll, 'mcp__playwright__browser_navigate');
    expect(other.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny' });
  });
});

describe('SdkObserver', () => {
  /** The CLI yields one assistant message per content block, each with the message_start usage. */
  const block = (id: string, content: unknown[]): SDKMessage =>
    ({
      type: 'assistant',
      session_id: 's1',
      parent_tool_use_id: null,
      uuid: crypto.randomUUID(),
      message: { id, model: 'claude-sonnet-5-5', content, stop_reason: null, usage: { input_tokens: 1000, output_tokens: 1 } },
    }) as unknown as SDKMessage;
  const result = (input: number, output: number): SDKMessage =>
    ({
      type: 'result',
      subtype: 'success',
      session_id: 's1',
      is_error: false,
      num_turns: 1,
      duration_ms: 10,
      total_cost_usd: 0.01,
      result: 'done',
      modelUsage: { 'claude-sonnet-5-5': { inputTokens: input, outputTokens: output, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
      permission_denials: [],
    }) as unknown as SDKMessage;

  it('reports each turn\'s tokens once, from the result, not once per content block', () => {
    const telemetry = new Telemetry('qa');
    const events: ObsEvent[] = [];
    vi.spyOn(telemetry, 'emit').mockImplementation((kind, data, ids = {}) => {
      events.push({ id: crypto.randomUUID(), ts: new Date().toISOString(), agent: 'qa', kind, ...ids, data });
    });
    const spans: Array<Record<string, unknown>> = [];
    vi.spyOn(telemetry, 'startSpan').mockImplementation((_name, attributes = {}) => {
      spans.push(attributes);
      return { span: undefined as never, traceparent: '', traceId: '', end: () => {} };
    });
    const observer = new SdkObserver(telemetry);

    observer.observe(block('msg_1', [{ type: 'text', text: 'Opening the basket.' }]));
    observer.observe(block('msg_1', [{ type: 'tool_use', id: 't', name: 'x', input: {} }]));
    expect(observer.observe(result(2000, 100))?.type).toBe('result');
    // A streaming session's next result carries the running total.
    observer.observe(block('msg_2', [{ type: 'text', text: 'done' }]));
    observer.observe(result(3500, 160));

    expect(events.filter((e) => e.kind === 'llm').every((e) => e.data.inputTokens === undefined)).toBe(true);
    expect(spans.map((s) => [s['gen_ai.usage.input_tokens'], s['gen_ai.usage.output_tokens']])).toEqual([
      [2000, 100],
      [1500, 60],
    ]);
    const qa = deriveAgents(events).find((a) => a.agent === 'qa')!;
    expect([qa.inputTokens, qa.outputTokens]).toEqual([3500, 160]);
  });
});
