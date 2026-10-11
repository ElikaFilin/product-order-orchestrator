/**
 * The part of the OpenClaw plugin API this plugin uses (OpenClaw 2026.9.9), narrowed to the fields we read so the
 * plugin can be driven by a fake host in tests. The real `OpenClawPluginApi` is structurally compatible.
 */
import type { TSchema } from 'typebox';

export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

export interface ToolResult {
  content: ToolContent[];
  details: unknown;
}

export interface PluginTool {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  execute(toolCallId: string, params: unknown): Promise<ToolResult>;
}

/** What a tool factory learns about the run that will call the tool. */
export interface ToolContext {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
}

export type ToolFactory = (ctx: ToolContext) => PluginTool | null | undefined;

export interface ToolCallEvent {
  toolName: string;
  params: Record<string, unknown>;
  toolCallId?: string;
  runId?: string;
}

export interface ToolHookContext {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  toolCallId?: string;
}

export interface BeforeToolCallResult {
  params?: Record<string, unknown>;
  block?: boolean;
  blockReason?: string;
}

export interface AfterToolCallEvent {
  toolName: string;
  params: Record<string, unknown>;
  toolCallId?: string;
  result?: unknown;
  error?: string;
}

export interface ToolResultMiddlewareEvent {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  isError?: boolean;
  result: ToolResult;
}

export interface ToolResultMiddlewareContext {
  agentId?: string;
  sessionKey?: string;
  runId?: string;
}

export interface PromptBuildEvent {
  prompt: string;
}

export interface AgentContext {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
}

export interface PromptBuildResult {
  appendContext?: string;
  toolsAllow?: string[];
}

export interface SubagentSpawnedEvent {
  childSessionKey: string;
  agentId: string;
  label?: string;
  runId: string;
}

export interface SubagentEndedEvent {
  targetSessionKey: string;
  reason: string;
  runId?: string;
  outcome?: 'ok' | 'error' | 'timeout' | 'killed' | 'reset' | 'deleted';
  error?: string;
}

export interface SubagentContext {
  runId?: string;
  childSessionKey?: string;
  requesterSessionKey?: string;
}

export interface MessageSendingEvent {
  to: string;
  content: string;
}

export interface MessageContext {
  channelId?: string;
  accountId?: string;
  conversationId?: string;
  sessionKey?: string;
}

export interface MessageSendingResult {
  content?: string;
  cancel?: boolean;
  cancelReason?: string;
}

export interface ResetEvent {
  reason?: string;
}

export interface HookHandlers {
  before_tool_call: (event: ToolCallEvent, ctx: ToolHookContext) => BeforeToolCallResult | void | Promise<BeforeToolCallResult | void>;
  after_tool_call: (event: AfterToolCallEvent, ctx: ToolHookContext) => void | Promise<void>;
  before_prompt_build: (event: PromptBuildEvent, ctx: AgentContext) => PromptBuildResult | void | Promise<PromptBuildResult | void>;
  subagent_spawned: (event: SubagentSpawnedEvent, ctx: SubagentContext) => void | Promise<void>;
  subagent_ended: (event: SubagentEndedEvent, ctx: SubagentContext) => void | Promise<void>;
  message_sending: (event: MessageSendingEvent, ctx: MessageContext) => MessageSendingResult | void | Promise<MessageSendingResult | void>;
  before_reset: (event: ResetEvent, ctx: AgentContext) => void | Promise<void>;
}

export interface PluginLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface PluginHost {
  pluginConfig?: Record<string, unknown>;
  logger: PluginLogger;
  registerTool(factory: ToolFactory, opts: { name: string }): void;
  on<K extends keyof HookHandlers>(hookName: K, handler: HookHandlers[K], opts?: { priority?: number }): void;
  registerAgentToolResultMiddleware(
    handler: (event: ToolResultMiddlewareEvent, ctx: ToolResultMiddlewareContext) => { result: ToolResult } | void | Promise<{ result: ToolResult } | void>,
    options?: { runtimes?: Array<'openclaw'> },
  ): void;
}
