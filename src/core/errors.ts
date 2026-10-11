import type { ErrorCode } from './contracts.js';

/** A failure the user can act on: `code` says what kind, `hint` (when set) what to do about it. */
export class AgentTaskError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'AgentTaskError';
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
