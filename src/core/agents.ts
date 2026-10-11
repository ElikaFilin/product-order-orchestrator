import path from 'node:path';

export const SUB_AGENTS = ['explore', 'execute', 'qa'] as const;
export type SubAgentName = (typeof SUB_AGENTS)[number];
export type AgentName = 'cos' | SubAgentName;

/** An agent's OpenClaw workspace in the repository: `agents/<id>/` (AGENTS.md and, for Explore, skills/). */
export function agentHome(repoRoot: string, name: AgentName): string {
  return path.join(repoRoot, 'agents', name);
}
