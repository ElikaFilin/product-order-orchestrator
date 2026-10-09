import path from 'node:path';
import { env, ROOT_DIR } from './env.js';

export const SUB_AGENTS = ['explore', 'execute', 'qa'] as const;
export type SubAgentName = (typeof SUB_AGENTS)[number];
export type AgentName = 'cos' | SubAgentName;

export interface SubAgentSpec {
  name: SubAgentName;
  title: string;
  description: string;
  /** Entry module started by the COS supervisor (or the launcher with SUBAGENTS_PRESTART=1). */
  entry: string;
  port: number;
  /** Base URL that serves /.well-known/agent-card.json and the A2A JSON-RPC endpoint. */
  baseUrl: string;
}

export function subAgentSpec(name: SubAgentName): SubAgentSpec {
  const e = env();
  const ports: Record<SubAgentName, number> = {
    explore: e.EXPLORE_PORT,
    execute: e.EXECUTE_PORT,
    qa: e.QA_PORT,
  };
  const meta: Record<SubAgentName, { title: string; description: string }> = {
    explore: {
      title: 'Explore agent',
      description:
        'Owns the product-list skill. Asks the user (through COS) which products and quantities to buy and returns the selection; also updates the product list.',
    },
    execute: {
      title: 'Execute agent',
      description:
        "Operates the user's default browser to make the shop basket contain the requested products and quantities.",
    },
    qa: {
      title: 'QA agent',
      description:
        "Opens the basket in the user's default browser, reads the order modal and reports differences against the expected selection.",
    },
  };
  const port = ports[name];
  return {
    name,
    ...meta[name],
    entry: path.join(ROOT_DIR, 'src', 'agents', name, 'main.ts'),
    port,
    baseUrl: `http://${e.A2A_HOST}:${port}`,
  };
}

/** Working directory of an agent (holds AGENTS.md and, for Explore, .claude/skills). */
export function agentHome(name: AgentName): string {
  return path.join(ROOT_DIR, 'agents', name);
}
