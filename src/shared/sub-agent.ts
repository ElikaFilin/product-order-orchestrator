/**
 * Bootstrap shared by the Explore / Execute / QA processes: telemetry, A2A server with an agent card,
 * graceful shutdown. Each agent only supplies its executor and card skills.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { subAgentSpec, type SubAgentName } from '../config/agents.js';
import { env } from '../config/env.js';
import { Telemetry } from '../observability/telemetry.js';
import { buildAgentCard, startA2AServer, type AgentCardInput } from './a2a.js';
import { createLogger, errorMessage } from './logger.js';
import type { LongLivedExecutor, TaskRunContext } from './task-executor.js';

/** Sub-agents never talk to Telegram; keep the bot token out of them and everything they start. */
const TELEGRAM_KEYS = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_USER_ID', 'TELEGRAM_API_ROOT'];
/** Stays inside COS's 5 s grace before it kills a sub-agent. */
const STOP_STEP_MS = 2_000;

export async function serveSubAgent(
  name: SubAgentName,
  skills: AgentCardInput['skills'],
  makeExecutor: (telemetry: Telemetry) => LongLivedExecutor,
): Promise<void> {
  for (const key of TELEGRAM_KEYS) delete process.env[key];
  const log = createLogger(name);
  const spec = subAgentSpec(name);
  const telemetry = new Telemetry(name);
  telemetry.status('starting', `A2A server on ${spec.baseUrl}`);

  const card = buildAgentCard({ name: spec.title, description: spec.description, baseUrl: spec.baseUrl, skills });
  const executor = makeExecutor(telemetry);
  const handle = await startA2AServer({ card, executor, host: env().A2A_HOST, port: spec.port });
  log.info({ url: spec.baseUrl }, 'A2A agent ready');
  telemetry.status('idle', 'ready');

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'shutting down');
    // Ctrl+C reaches this process at the same time as COS, so COS cannot cancel our tasks: cancel them here,
    // which also runs their browser cleanup (agent-browser's daemon would otherwise stay attached to the browser).
    await executor.shutdown(STOP_STEP_MS);
    telemetry.status('stopped', signal);
    await telemetry.flush(); // the hub stops after COS, so the last status still reaches the board
    await Promise.race([handle.close(), delay(STOP_STEP_MS, undefined, { ref: false })]);
    await telemetry.shutdown();
    process.exit(0);
  };
  process.once('SIGINT', () => void stop('SIGINT'));
  process.once('SIGTERM', () => void stop('SIGTERM'));
  process.on('unhandledRejection', (err) => telemetry.error(err, { source: 'unhandledRejection' }));
}

/** Run `main` and exit non-zero with a readable message if startup fails. */
export function runMain(name: string, main: () => Promise<void>): void {
  main().catch((err) => {
    process.stderr.write(`[${name}] failed to start: ${errorMessage(err)}\n`);
    process.exit(1);
  });
}

/**
 * In-process MCP server exposing `ask_user`: the sub-agent's only way to reach the human.
 * It parks the A2A task in INPUT_REQUIRED; COS relays the question and sends back the answer.
 */
export function askUserServer(serverName: string, ctx: TaskRunContext): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({ name: serverName, version: '0.1.0', tools: [askUserTool(ctx)], alwaysLoad: true });
}

/** The `ask_user` tool definition, for agents that bundle it with their own in-process tools. */
export function askUserTool(ctx: TaskRunContext) {
  return tool(
    'ask_user',
    'Ask the human a question. The Chief of Staff relays it (you never talk to the human directly) and the ' +
      'answer text is returned. Ask only when you cannot proceed without the human; ask one clear question.',
    {
      question: z.string().min(1).describe('The full question, self-contained, in the user language'),
      options: z.array(z.string()).max(10).optional().describe('Optional short answer choices'),
    },
    async ({ question, options }) => {
      try {
        const answer = await ctx.ask(question, options);
        return { content: [{ type: 'text', text: answer }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `ask_user failed: ${errorMessage(err)}` }], isError: true };
      }
    },
    { annotations: { readOnlyHint: false, openWorldHint: true } },
  );
}
