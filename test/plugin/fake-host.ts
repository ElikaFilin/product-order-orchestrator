/**
 * A stand-in for the OpenClaw plugin API: records the tools, hooks and result middleware the plugin registers and
 * calls them the way the gateway does (tool params are checked against the tool's typebox schema first).
 */
import { Value } from 'typebox/value';
import type {
  AgentContext,
  BeforeToolCallResult,
  HookHandlers,
  PluginHost,
  ToolContext,
  ToolFactory,
  ToolHookContext,
  ToolResult,
  ToolResultMiddlewareContext,
  ToolResultMiddlewareEvent,
} from '../../src/plugin/host.js';

type Middleware = (event: ToolResultMiddlewareEvent, ctx: ToolResultMiddlewareContext) => unknown;

export const COS = { agentId: 'cos', sessionKey: 'agent:cos:main', runId: 'run-cos' };

export function child(agentId: 'explore' | 'execute' | 'qa', n = 1, runId = `run-${agentId}-${n}`) {
  return { agentId, sessionKey: `agent:${agentId}:subagent:00000000-0000-4000-8000-00000000000${n}`, runId };
}

export class FakeHost implements PluginHost {
  pluginConfig: Record<string, unknown> | undefined;
  readonly logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
  readonly factories = new Map<string, ToolFactory>();
  readonly handlers: { [K in keyof HookHandlers]?: Array<HookHandlers[K]> } = {};
  readonly middleware: Middleware[] = [];
  private seq = 0;

  registerTool(factory: ToolFactory, opts: { name: string }): void {
    this.factories.set(opts.name, factory);
  }

  on<K extends keyof HookHandlers>(hookName: K, handler: HookHandlers[K]): void {
    (this.handlers[hookName] ??= [] as never).push(handler as never);
  }

  registerAgentToolResultMiddleware(handler: Middleware): void {
    this.middleware.push(handler);
  }

  /** The tools a run of this agent would see (factories that return a tool). */
  toolNames(ctx: ToolContext): string[] {
    return [...this.factories.entries()].filter(([, f]) => f(ctx)).map(([name]) => name);
  }

  /** Call a plugin tool as the agent of `ctx`; returns the text result (JSON-parsed when it is JSON). */
  async tool(name: string, params: Record<string, unknown>, ctx: ToolContext): Promise<any> {
    const tool = this.factories.get(name)?.(ctx);
    if (!tool) throw new Error(`${name} is not offered to ${ctx.agentId}`);
    if (!Value.Check(tool.parameters, params)) throw new Error(`${name}: params do not match the schema: ${JSON.stringify(params)}`);
    const result = await tool.execute(this.nextId(), params);
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  /** Every before_tool_call handler, like the gateway: the first block wins, the last params win. */
  async before(toolName: string, params: Record<string, unknown>, ctx: ToolHookContext, toolCallId = this.nextId()) {
    let out: BeforeToolCallResult = {};
    for (const h of this.handlers.before_tool_call ?? []) {
      const r = await h({ toolName, params: out.params ?? params, toolCallId, runId: ctx.runId }, { ...ctx, toolCallId });
      if (r?.block) return { ...r, toolCallId };
      if (r?.params) out = { params: r.params };
    }
    return { ...out, toolCallId };
  }

  /** The result middleware chain; returns what the model would see. */
  async result(toolName: string, args: Record<string, unknown>, result: ToolResult, ctx: ToolResultMiddlewareContext, toolCallId: string, isError = false) {
    let current = result;
    for (const m of this.middleware) {
      const r = (await m({ toolCallId, toolName, args, isError, result: current }, ctx)) as { result: ToolResult } | undefined;
      if (r?.result) current = r.result;
    }
    return current;
  }

  async emit<K extends keyof HookHandlers>(hookName: K, event: Parameters<HookHandlers[K]>[0], ctx: Parameters<HookHandlers[K]>[1]): Promise<unknown[]> {
    const out: unknown[] = [];
    for (const h of this.handlers[hookName] ?? []) out.push(await (h as (e: unknown, c: unknown) => unknown)(event, ctx));
    return out;
  }

  async promptBuild(ctx: AgentContext) {
    const [r] = await this.emit('before_prompt_build', { prompt: '' }, ctx);
    return r as { appendContext?: string; toolsAllow?: string[] } | undefined;
  }

  private nextId(): string {
    this.seq += 1;
    return `call-${this.seq}`;
  }
}

export const textResult = (text: string, details: unknown = {}): ToolResult => ({ content: [{ type: 'text', text }], details });

/** A Playwright MCP result carrying a page script's return value. */
export const pageResult = (value: unknown): ToolResult => textResult(`### Result\n${JSON.stringify(value)}\n### Ran Playwright code\nawait page.evaluate(...)`);
