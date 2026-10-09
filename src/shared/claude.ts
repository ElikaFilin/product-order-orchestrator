/**
 * Claude Agent SDK wiring shared by all agents: a locked-down tool surface, a PreToolUse guard,
 * and telemetry (dashboard events + OTel spans) for every tool call, model turn and run.
 */
import { setTimeout as delay } from 'node:timers/promises';
import {
  query,
  type HookCallback,
  type HookCallbackMatcher,
  type HookEvent,
  type McpServerConfig,
  type ModelUsage,
  type Options,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { AgentName } from '../config/agents.js';
import { env, runtimeDir } from '../config/env.js';
import type { ObsIds } from '../observability/events.js';
import { preview, SpanKind, type SpanHandle, type Telemetry } from '../observability/telemetry.js';
import { AgentTaskError } from './task-executor.js';
import { errorMessage } from './logger.js';

/**
 * Built-in Claude Code tools that no agent in this system may use. `tools: []` already removes
 * them from the model's context; this list is defense in depth (and turns off tool search so
 * MCP tool schemas load up front).
 */
export const DISALLOWED_BUILTINS = [
  'Bash',
  'BashOutput',
  'KillShell',
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'LS',
  'WebFetch',
  'WebSearch',
  'Agent',
  'Task',
  'TodoWrite',
  'AskUserQuestion',
  'ExitPlanMode',
  'EnterPlanMode',
  'ToolSearch',
  'Monitor',
  'CronCreate',
  'CronDelete',
  'CronList',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
];

/** The CLI returns `outputSchema` results through this tool; dontAsk lets it through without an allowedTools entry. */
export const STRUCTURED_OUTPUT_TOOL = 'StructuredOutput';

/** What a guard decides for one tool call. Undefined = allow unchanged. */
export interface GuardDecision {
  deny?: string;
  updatedInput?: Record<string, unknown>;
}
export type ToolGuard = (toolName: string, input: Record<string, unknown>) => GuardDecision | undefined;

/**
 * Environment for the Claude Code child process. `options.env` REPLACES the child's environment,
 * so start from process.env, drop variables inherited from a surrounding Claude Code session,
 * and isolate the CLI's config/session dir under .runtime/claude. No agent's CLI gets the Telegram
 * settings: COS talks to Telegram from its own Node process, never through the CLI.
 */
export function agentProcessEnv(): Record<string, string> {
  const insideClaudeCode = Boolean(process.env.CLAUDECODE);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_') || key === 'CLAUDE_CONFIG_DIR') continue;
    if (key.startsWith('TELEGRAM_')) continue;
    if (insideClaudeCode && (key === 'ANTHROPIC_BASE_URL' || key === 'ANTHROPIC_AUTH_TOKEN')) continue;
    out[key] = value;
  }
  out.CLAUDE_CONFIG_DIR = runtimeDir('claude');
  out.CLAUDE_AGENT_SDK_CLIENT_APP = 'product-order-orchestrator/0.1.0';
  out.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  out.DISABLE_AUTOUPDATER = '1';
  out.ENABLE_TOOL_SEARCH = 'false';
  // With settingSources ['project'] the CLI walks up from cwd and would load ~/.claude/CLAUDE.md (the
  // developer's private instructions) into the agent's prompt. Agents get their instructions only from us.
  out.CLAUDE_CODE_DISABLE_CLAUDE_MDS = '1';
  out.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  return out;
}

export function requireApiKey(): void {
  if (!env().ANTHROPIC_API_KEY) {
    throw new AgentTaskError(
      'LLM_ERROR',
      'ANTHROPIC_API_KEY is not set.',
      'Put your Anthropic API key into .env (see .env.example) and restart.',
    );
  }
}

export interface AgentOptionsInput {
  agent: AgentName;
  model: string;
  cwd: string;
  systemPrompt: string;
  /** Built-in Claude Code tools to keep (default none). Explore keeps ['Skill']. */
  builtInTools?: string[];
  skills?: string[];
  /** 'project' loads <cwd>/.claude (skills). Default: no settings files at all. */
  settingSources?: Array<'project'>;
  mcpServers: Record<string, McpServerConfig>;
  /** Pre-approved tools: exact names or `mcp__<server>__*`. Everything else is denied (dontAsk). */
  allowedTools: string[];
  disallowedTools?: string[];
  guard?: ToolGuard;
  /**
   * Sees every finished tool call: the agent's own input (before a guard rewrote it) and the raw response.
   * Lets code read page data itself instead of trusting the model's retyped copy. Errors are ignored.
   */
  onToolResult?: (toolName: string, input: Record<string, unknown>, response: unknown) => void;
  /** Returns a replacement tool response (shown to the model, telemetry and transcripts), or undefined to keep it. */
  redactOutput?: (toolName: string, response: unknown) => unknown;
  outputSchema?: z.ZodType;
  maxTurns: number;
  maxBudgetUsd: number;
  abortController?: AbortController;
  telemetry: Telemetry;
  /** Parent span for tool/model spans. */
  span?: SpanHandle;
  ids?: ObsIds;
}

/** Build Agent SDK options with this project's security posture and telemetry hooks. */
export function buildAgentOptions(input: AgentOptionsInput): Options {
  const e = env();
  return {
    model: input.model,
    effort: e.AGENT_EFFORT,
    cwd: input.cwd,
    systemPrompt: input.systemPrompt,
    tools: input.builtInTools ?? [],
    ...(input.skills ? { skills: input.skills } : {}),
    settingSources: input.settingSources ?? [],
    // Skill text is ours, but product names typed in Telegram end up in it: never run `!`cmd`` from a skill.
    settings: { disableBundledSkills: true, disableSkillShellExecution: true },
    // No agent resumes a session; full transcripts would keep raw tool output (page text, tab lists) on disk.
    persistSession: false,
    strictMcpConfig: true,
    mcpServers: input.mcpServers,
    allowedTools: input.allowedTools,
    disallowedTools: [...DISALLOWED_BUILTINS.filter((t) => !(input.builtInTools ?? []).includes(t)), ...(input.disallowedTools ?? [])],
    permissionMode: 'dontAsk',
    hooks: buildHooks(input),
    maxTurns: input.maxTurns,
    maxBudgetUsd: input.maxBudgetUsd,
    ...(input.abortController ? { abortController: input.abortController } : {}),
    ...(input.outputSchema ? { outputFormat: { type: 'json_schema', schema: outputJsonSchema(input.outputSchema) } } : {}),
    env: agentProcessEnv(),
    stderr: (data: string) => input.telemetry.emit('log', { level: 'debug', source: 'claude-cli', text: preview(data, 500) }, input.ids),
  };
}

/**
 * The CLI validates --json-schema with a validator that rejects zod's default draft-2020-12 `$schema`
 * (the run exits before any model call). The schema becomes the StructuredOutput tool's input_schema,
 * so its root must be an object (no top-level union).
 */
function outputJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...json } = z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>;
  return json;
}

/** Observers and redactors must never break a run. */
function guarded<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

function buildHooks(input: AgentOptionsInput): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const { telemetry, ids = {} } = input;
  const toolSpans = new Map<string, SpanHandle>();
  /** The agent's own input per tool call, before a guard rewrote it. */
  const toolInputs = new Map<string, Record<string, unknown>>();

  const pre: HookCallback = async (hook) => {
    if (hook.hook_event_name !== 'PreToolUse') return {};
    const toolInput = (hook.tool_input ?? {}) as Record<string, unknown>;
    // A guard must never block the final answer: outputSchema results arrive through StructuredOutput.
    const decision = hook.tool_name === STRUCTURED_OUTPUT_TOOL ? undefined : input.guard?.(hook.tool_name, toolInput);
    telemetry.emit(
      'tool_call',
      {
        tool: hook.tool_name,
        toolUseId: hook.tool_use_id,
        input: preview(toolInput),
        ...(decision?.deny ? { denied: decision.deny } : {}),
        ...(decision?.updatedInput ? { rewritten: true } : {}),
      },
      ids,
    );
    if (decision?.deny) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: decision.deny,
        },
      };
    }
    toolInputs.set(hook.tool_use_id, toolInput);
    toolSpans.set(
      hook.tool_use_id,
      telemetry.startSpan(
        `execute_tool ${hook.tool_name}`,
        {
          'gen_ai.operation.name': 'execute_tool',
          'gen_ai.tool.name': hook.tool_name,
          'gen_ai.tool.call.id': hook.tool_use_id,
          'gen_ai.tool.call.arguments': preview(toolInput, 4_000),
        },
        input.span,
      ),
    );
    if (decision?.updatedInput) {
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: decision.updatedInput } };
    }
    return {};
  };

  const post: HookCallback = async (hook) => {
    if (hook.hook_event_name === 'PostToolUse') {
      const agentInput = toolInputs.get(hook.tool_use_id) ?? ((hook.tool_input ?? {}) as Record<string, unknown>);
      toolInputs.delete(hook.tool_use_id);
      const redacted = guarded(() => input.redactOutput?.(hook.tool_name, hook.tool_response));
      telemetry.emit(
        'tool_result',
        {
          tool: hook.tool_name,
          toolUseId: hook.tool_use_id,
          ok: true,
          durationMs: hook.duration_ms,
          output: preview(redacted ?? hook.tool_response, 1_500),
        },
        ids,
      );
      toolSpans.get(hook.tool_use_id)?.end(undefined, { 'gen_ai.tool.duration_ms': hook.duration_ms ?? 0 });
      toolSpans.delete(hook.tool_use_id);
      guarded(() => input.onToolResult?.(hook.tool_name, agentInput, hook.tool_response));
      if (redacted !== undefined) {
        return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: redacted } };
      }
    } else if (hook.hook_event_name === 'PostToolUseFailure') {
      toolInputs.delete(hook.tool_use_id);
      telemetry.emit(
        'tool_result',
        { tool: hook.tool_name, toolUseId: hook.tool_use_id, ok: false, error: preview(hook.error, 1_500) },
        ids,
      );
      toolSpans.get(hook.tool_use_id)?.end(new Error(String(hook.error)));
      toolSpans.delete(hook.tool_use_id);
    }
    return {};
  };

  return {
    PreToolUse: [{ hooks: [pre] }],
    PostToolUse: [{ hooks: [post] }],
    PostToolUseFailure: [{ hooks: [post] }],
  };
}

/**
 * Forwards the SDK messages of ONE query() to telemetry. Used by the single-shot runner and by each of COS's
 * long-lived sessions.
 *
 * Token usage is taken from the result's modelUsage, never from `assistant` messages: the CLI yields one
 * assistant message per content block, each carrying the message_start usage (the full input again and a
 * placeholder output of ~1). modelUsage is a running total per query(), so each result reports the
 * difference to the previous one.
 */
export class SdkObserver {
  private readonly reported = new Map<string, ModelUsage>();

  constructor(
    private readonly telemetry: Telemetry,
    private readonly ids: ObsIds = {},
    private readonly span?: SpanHandle,
  ) {}

  /** Returns the result message when `msg` is one. */
  observe(msg: SDKMessage): SDKResultMessage | undefined {
    const { telemetry, ids } = this;
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          telemetry.emit(
            'log',
            {
              level: 'info',
              text: 'agent session started',
              model: msg.model,
              tools: msg.tools,
              mcpServers: msg.mcp_servers,
              skills: msg.skills,
              apiKeySource: msg.apiKeySource,
            },
            { ...ids, sessionId: msg.session_id },
          );
        } else if (msg.subtype === 'api_retry') {
          telemetry.emit('log', { level: 'warn', text: 'model API retry', detail: preview(msg) }, ids);
        }
        return undefined;
      case 'assistant': {
        const m = msg.message;
        const texts = m.content.flatMap((b) => (b.type === 'text' ? [b.text] : []));
        telemetry.emit(
          'llm',
          {
            model: m.model,
            messageId: m.id,
            stopReason: m.stop_reason,
            text: texts.length ? preview(texts.join('\n'), 1_000) : undefined,
            error: msg.error,
          },
          { ...ids, sessionId: msg.session_id },
        );
        return undefined;
      }
      case 'result': {
        const totals = sumUsage(Object.values(msg.modelUsage ?? {}));
        telemetry.emit(
          'run',
          {
            subtype: msg.subtype,
            isError: msg.is_error,
            numTurns: msg.num_turns,
            durationMs: msg.duration_ms,
            costUsd: msg.total_cost_usd,
            inputTokens: totals.inputTokens,
            outputTokens: totals.outputTokens,
            cacheReadTokens: totals.cacheReadInputTokens,
            cacheCreationTokens: totals.cacheCreationInputTokens,
            modelUsage: msg.modelUsage,
            permissionDenials: msg.permission_denials,
            errors: msg.subtype === 'success' ? undefined : msg.errors,
          },
          { ...ids, sessionId: msg.session_id },
        );
        this.reportTurnUsage(msg);
        return msg;
      }
      default:
        return undefined;
    }
  }

  /** One `chat <model>` span per model with this turn's tokens (ClawMetry prices tokens from these spans). */
  private reportTurnUsage(msg: SDKResultMessage): void {
    for (const [model, usage] of Object.entries(msg.modelUsage ?? {})) {
      const before = this.reported.get(model);
      this.reported.set(model, usage);
      const delta = (key: UsageKey) => Math.max(0, (usage[key] ?? 0) - (before?.[key] ?? 0));
      const turn = {
        input: delta('inputTokens'),
        output: delta('outputTokens'),
        cacheRead: delta('cacheReadInputTokens'),
        cacheCreation: delta('cacheCreationInputTokens'),
      };
      if (turn.input + turn.output + turn.cacheRead + turn.cacheCreation === 0) continue;
      this.telemetry
        .startSpan(
          `chat ${model}`,
          {
            'gen_ai.operation.name': 'chat',
            'gen_ai.provider.name': 'anthropic',
            'gen_ai.request.model': model,
            'gen_ai.response.model': model,
            'gen_ai.usage.input_tokens': turn.input,
            'gen_ai.usage.output_tokens': turn.output,
            'gen_ai.usage.cache_read.input_tokens': turn.cacheRead,
            'gen_ai.usage.cache_creation.input_tokens': turn.cacheCreation,
            'session.id': msg.session_id,
          },
          this.span,
        )
        .end();
    }
  }
}

type UsageKey = 'inputTokens' | 'outputTokens' | 'cacheReadInputTokens' | 'cacheCreationInputTokens';

function sumUsage(usages: readonly ModelUsage[]): Record<UsageKey, number> {
  const sum = (key: UsageKey) => usages.reduce((total, u) => total + (u[key] ?? 0), 0);
  return {
    inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'),
    cacheReadInputTokens: sum('cacheReadInputTokens'),
    cacheCreationInputTokens: sum('cacheCreationInputTokens'),
  };
}

/** How long a canceled run's CLI may take to acknowledge the interrupt before it is closed anyway. */
const INTERRUPT_GRACE_MS = 1_500;

export interface RunResult<T> {
  structured: T;
  text: string;
  costUsd: number;
  sessionId: string;
}

/**
 * Single-shot agent run (used by the sub-agents for one A2A task). Throws AgentTaskError on
 * model/budget/turn failures and on cancellation.
 */
export async function runAgent<T>(
  input: AgentOptionsInput & { prompt: string; outputSchema: z.ZodType<T>; signal: AbortSignal },
): Promise<RunResult<T>> {
  requireApiKey();
  const abortController = new AbortController();
  let run: Query | undefined;
  const stop = () => {
    abortController.abort(input.signal.reason);
    run?.close();
  };
  // Closing alone only ends the CLI's stdin (SIGTERM follows ~2 s later): meanwhile the CLI answers the cut tool
  // call and calls the model again. An interrupt, written before a canceled tool's result, ends the turn first.
  const onAbort = () => {
    if (!run) return stop();
    void Promise.race([run.interrupt().catch(() => undefined), delay(INTERRUPT_GRACE_MS, undefined, { ref: false })]).finally(stop);
  };
  if (input.signal.aborted) onAbort();
  input.signal.addEventListener('abort', onAbort, { once: true });

  const observer = new SdkObserver(input.telemetry, input.ids, input.span);
  let result: SDKResultMessage | undefined;
  try {
    run = query({ prompt: input.prompt, options: buildAgentOptions({ ...input, abortController }) });
    for await (const msg of run) {
      result = observer.observe(msg) ?? result;
    }
  } catch (err) {
    if (input.signal.aborted) throw new AgentTaskError('CANCELED', 'Canceled by COS');
    if (!result) throw new AgentTaskError('LLM_ERROR', `Agent run failed: ${errorMessage(err)}`);
    // query() throws after an error result; fall through and report the result below.
  } finally {
    input.signal.removeEventListener('abort', onAbort);
  }

  if (input.signal.aborted) throw new AgentTaskError('CANCELED', 'Canceled by COS');
  if (!result) throw new AgentTaskError('LLM_ERROR', 'Agent run ended without a result.');
  if (result.subtype === 'error_max_budget_usd') {
    throw new AgentTaskError('BUDGET_EXCEEDED', `Budget of $${input.maxBudgetUsd} exceeded.`);
  }
  if (result.is_error || result.subtype !== 'success') {
    const detail = result.subtype === 'success' ? result.result : result.errors.join('; ');
    throw new AgentTaskError('LLM_ERROR', `Agent run failed (${result.subtype}): ${detail}`);
  }
  const parsed = input.outputSchema.safeParse(result.structured_output);
  if (!parsed.success) {
    throw new AgentTaskError('LLM_ERROR', `Agent returned an invalid result: ${z.prettifyError(parsed.error)}`);
  }
  return { structured: parsed.data, text: result.result, costUsd: result.total_cost_usd, sessionId: result.session_id };
}

/** Span kind re-export for callers that start client spans around A2A calls. */
export { SpanKind };
