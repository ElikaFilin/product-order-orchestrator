import { pino, type Logger } from 'pino';
import { env } from '../config/env.js';

/** Logs go to stderr so stdout stays free (stdio MCP servers use stdout as their protocol channel). */
export function createLogger(name: string): Logger {
  return pino({ name, level: env().LOG_LEVEL }, pino.destination(2));
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
