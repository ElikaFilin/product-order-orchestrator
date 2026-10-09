/**
 * Thin helpers over @a2a-js/sdk 1.3 (A2A protocol v1.0). The SDK's protobuf-generated types
 * require every field, so message/part construction lives here.
 */
import type { Server } from 'node:http';
import express from 'express';
import {
  A2A_PROTOCOL_VERSION,
  AGENT_CARD_PATH,
  Role,
  TaskState,
  taskStateToJSON,
  type AgentCard,
  type Artifact,
  type Message,
  type Part,
  type SendMessageRequest,
  type Task,
} from '@a2a-js/sdk';
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  type AgentExecutor,
} from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { ClientFactory, ClientFactoryOptions, JsonRpcTransportFactory, type Client } from '@a2a-js/sdk/client';
import { isLoopbackHostHeader } from './loopback.js';

export { AGENT_CARD_PATH, Role, TaskState, type AgentCard, type Artifact, type Message, type Part, type Task };

export const JSONRPC_PATH = '/a2a/jsonrpc';

// ---------- parts & messages ----------

export const textPart = (text: string): Part => ({
  content: { $case: 'text', value: text },
  metadata: undefined,
  filename: '',
  mediaType: 'text/plain',
});

export const dataPart = (data: unknown): Part => ({
  content: { $case: 'data', value: data },
  metadata: undefined,
  filename: '',
  mediaType: 'application/json',
});

export interface MessageIds {
  taskId?: string;
  contextId?: string;
  metadata?: Record<string, unknown>;
}

export function makeMessage(role: Role, parts: Part[], ids: MessageIds = {}): Message {
  return {
    messageId: crypto.randomUUID(),
    role,
    parts,
    taskId: ids.taskId ?? '',
    contextId: ids.contextId ?? '',
    metadata: ids.metadata ?? {},
    extensions: [],
    referenceTaskIds: [],
  };
}

export function sendRequest(message: Message): SendMessageRequest {
  return { tenant: '', message, configuration: undefined, metadata: {} };
}

/** All text parts joined by blank lines. */
export function textOf(parts: readonly Part[] | undefined): string {
  return (parts ?? [])
    .map((p) => (p.content?.$case === 'text' ? p.content.value : undefined))
    .filter((t): t is string => typeof t === 'string' && t.length > 0)
    .join('\n\n');
}

/** All data-part payloads, in order. */
export function dataOf(parts: readonly Part[] | undefined): unknown[] {
  return (parts ?? []).flatMap((p) => (p.content?.$case === 'data' ? [p.content.value] : []));
}

export function artifactData(task: Task | undefined): unknown[] {
  return (task?.artifacts ?? []).flatMap((a) => dataOf(a.parts));
}

/** 'TASK_STATE_INPUT_REQUIRED' -> 'input-required'. */
export function stateName(state: TaskState | undefined): string {
  if (state === undefined) return 'unknown';
  return taskStateToJSON(state).replace(/^TASK_STATE_/, '').toLowerCase().replace(/_/g, '-');
}

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED,
]);

// ---------- server ----------

export interface AgentCardInput {
  name: string;
  description: string;
  baseUrl: string;
  skills: Array<{ id: string; name: string; description: string; tags?: string[]; examples?: string[] }>;
}

export function buildAgentCard(input: AgentCardInput): AgentCard {
  return {
    name: input.name,
    description: input.description,
    supportedInterfaces: [
      {
        url: `${input.baseUrl}${JSONRPC_PATH}`,
        protocolBinding: 'JSONRPC',
        tenant: '',
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
    ],
    provider: { organization: 'product-order-orchestrator', url: 'https://github.com/ElikaFilin/product-order-orchestrator' },
    version: '0.1.0',
    capabilities: { streaming: true, pushNotifications: false, extensions: [], extendedAgentCard: false },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills: input.skills.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      tags: s.tags ?? [],
      examples: s.examples ?? [],
      inputModes: ['text/plain', 'application/json'],
      outputModes: ['application/json'],
      securityRequirements: [],
    })),
    signatures: [],
  };
}

export interface A2AServerHandle {
  server: Server;
  close(): Promise<void>;
}

/** Serve an executor as an A2A agent: agent card + JSON-RPC (incl. streaming) on 127.0.0.1. */
export async function startA2AServer(opts: {
  card: AgentCard;
  executor: AgentExecutor;
  host: string;
  port: number;
  onRequest?: (method: string, url: string) => void;
}): Promise<A2AServerHandle> {
  const requestHandler = new DefaultRequestHandler(opts.card, new InMemoryTaskStore(), opts.executor);
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    // No authentication: only local clients that address us by a loopback name (no DNS rebinding).
    if (!isLoopbackHostHeader(req.headers.host)) {
      res.status(403).json({ error: 'Host not allowed' });
      return;
    }
    opts.onRequest?.(req.method, req.url);
    next();
  });
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, agent: opts.card.name });
  });
  app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler }));
  app.use(JSONRPC_PATH, jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));
  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(opts.port, opts.host, (err?: Error) => (err ? reject(err) : resolve(s)));
  });
  return {
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ---------- client ----------

export async function createA2AClient(baseUrl: string): Promise<Client> {
  const factory = new ClientFactory(
    ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      transports: [new JsonRpcTransportFactory()],
      preferredTransports: ['JSONRPC'],
    }),
  );
  return factory.createFromUrl(baseUrl);
}

export async function fetchAgentCard(baseUrl: string, timeoutMs = 1_500): Promise<AgentCard | undefined> {
  try {
    const res = await fetch(`${baseUrl}/${AGENT_CARD_PATH}`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? ((await res.json()) as AgentCard) : undefined;
  } catch {
    return undefined;
  }
}
