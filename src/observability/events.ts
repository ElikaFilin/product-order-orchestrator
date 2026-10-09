import { z } from 'zod';

export const OBS_KINDS = [
  'status', // agent lifecycle / state change
  'a2a', // A2A message sent or received (task state changes included)
  'tool_call', // agent requested a tool
  'tool_result', // tool finished (ok or error)
  'llm', // one model turn: model, tokens, cost
  'run', // one Agent SDK run finished
  'telegram', // message in/out of the Telegram chat
  'error',
  'log',
] as const;
export type ObsKind = (typeof OBS_KINDS)[number];

export const AGENT_STATES = ['starting', 'idle', 'busy', 'waiting_input', 'error', 'stopped'] as const;
export type AgentState = (typeof AGENT_STATES)[number];

export const ObsEvent = z.object({
  id: z.string().min(1),
  ts: z.string().min(1),
  agent: z.string().min(1),
  kind: z.enum(OBS_KINDS),
  taskId: z.string().optional(),
  contextId: z.string().optional(),
  sessionId: z.string().optional(),
  traceId: z.string().optional(),
  data: z.record(z.string(), z.unknown()).default({}),
});
export type ObsEvent = z.infer<typeof ObsEvent>;

export const ObsEventBatch = z.union([ObsEvent, z.array(ObsEvent).max(500)]);

/** Correlation ids attached to an event. */
export interface ObsIds {
  taskId?: string;
  contextId?: string;
  sessionId?: string;
  traceId?: string;
}
