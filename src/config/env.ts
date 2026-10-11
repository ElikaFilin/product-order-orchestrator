import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** Absolute path of the repository root (two levels above this file). */
export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Empty or whitespace-only values count as unset. */
const optionalText = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

/**
 * The project's settings and secrets (.env). Every pnpm script loads .env, including `pnpm start`, so the OpenClaw
 * gateway gets the secrets from the same file.
 */
const EnvSchema = z.object({
  ANTHROPIC_API_KEY: optionalText,

  TELEGRAM_BOT_TOKEN: optionalText,
  /** Numeric Telegram user id allowed to talk to the bot (COS). */
  TELEGRAM_ALLOWED_USER_ID: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== '' ? Number(v) : undefined))
    .refine((v) => v === undefined || Number.isSafeInteger(v), 'TELEGRAM_ALLOWED_USER_ID must be a number'),

  /**
   * How Execute and QA reach Chrome. extension: the user's own Chrome profile through the Playwright Extension
   * (no debugging port). cdp: a Chrome started with remote debugging (`pnpm browser:chrome`, the tests).
   */
  BROWSER_MODE: z.enum(['extension', 'cdp']).default('extension'),
  /** Extension mode: the Chrome profile directory that has the extension ("Default", "Profile 4", ...). */
  CHROME_PROFILE_DIR: z.string().trim().min(1).default('Default'),
  /** Extension mode: the extension's token. Without it Chrome asks the user to approve every agent run. */
  PLAYWRIGHT_MCP_EXTENSION_TOKEN: optionalText,
  /** CDP mode: Chrome DevTools Protocol endpoint (`pnpm browser:chrome` listens on 9333). */
  BROWSER_CDP_URL: z.string().url().default('http://127.0.0.1:9333'),

  DEFAULT_SHOP: z.string().default('karashynyard'),

  RUNTIME_DIR: z.string().default('.runtime'),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

/** Parsed, validated environment. `.env` is loaded by node --env-file-if-exists in package.json scripts. */
export function env(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(parsed.error)}`);
  }
  cached = parsed.data;
  return cached;
}

/** Absolute runtime directory (logs, browser artifacts). */
export function runtimeDir(...segments: string[]): string {
  return path.resolve(ROOT_DIR, env().RUNTIME_DIR, ...segments);
}

/** Test hook: forget the cached env so tests can change process.env. */
export function resetEnvCache(): void {
  cached = undefined;
}
