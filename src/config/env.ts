import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** Absolute path of the repository root (two levels above this file). */
export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const bool = z
  .string()
  .optional()
  .transform((v) => v === '1' || v?.toLowerCase() === 'true');

/** Empty or whitespace-only values count as unset. */
const optionalText = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const port = (fallback: number) => z.coerce.number().int().min(1).max(65535).default(fallback);
const usd = (fallback: number) => z.coerce.number().positive().default(fallback);

/** The A2A servers and the dashboard hub have no authentication, so they only ever listen on loopback. */
const loopbackHost = z
  .string()
  .default('127.0.0.1')
  .refine((h) => h === '127.0.0.1' || h === 'localhost', 'must be 127.0.0.1 or localhost (the A2A servers and the dashboard have no authentication)');

const EnvSchema = z.object({
  ANTHROPIC_API_KEY: z.string().optional(),

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  /** Numeric Telegram user id allowed to talk to the bot. Empty = setup mode (bot only tells you your id). */
  TELEGRAM_ALLOWED_USER_ID: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== '' ? Number(v) : undefined))
    .refine((v) => v === undefined || Number.isSafeInteger(v), 'TELEGRAM_ALLOWED_USER_ID must be a number'),
  /** Bot API root override (tests / a local Bot API server). Empty = https://api.telegram.org. */
  TELEGRAM_API_ROOT: optionalText,

  COS_MODEL: z.string().default('claude-opus-5-5'),
  EXPLORE_MODEL: z.string().default('claude-sonnet-5-5'),
  EXECUTE_MODEL: z.string().default('claude-sonnet-5-5'),
  QA_MODEL: z.string().default('claude-sonnet-5-5'),
  AGENT_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),

  COS_MAX_BUDGET_USD: usd(2),
  EXPLORE_MAX_BUDGET_USD: usd(0.5),
  EXECUTE_MAX_BUDGET_USD: usd(3),
  QA_MAX_BUDGET_USD: usd(1.5),

  A2A_HOST: loopbackHost,
  EXPLORE_PORT: port(41001),
  EXECUTE_PORT: port(41002),
  QA_PORT: port(41003),
  /** 1 = launcher starts every sub-agent up front instead of COS spawning them on demand. */
  SUBAGENTS_PRESTART: bool,
  /** Max time COS waits for one sub-agent turn (ms). Execute can take minutes. */
  SUBAGENT_TIMEOUT_MS: z.coerce.number().int().positive().default(30 * 60_000),

  /**
   * How Execute and QA reach Chrome. extension: the user's own Chrome profile through the Playwright MCP Bridge
   * extension (no debugging port). cdp: a Chrome started with remote debugging (`pnpm browser:chrome`, the tests).
   */
  BROWSER_MODE: z.enum(['extension', 'cdp']).default('extension'),
  /** Extension mode: the Chrome profile directory that has the extension ("Default", "Profile 4", ...). */
  CHROME_PROFILE_DIR: z.string().trim().min(1).default('Default'),
  /** Extension mode: the extension's token. Without it Chrome asks the user to approve every agent run. */
  PLAYWRIGHT_MCP_EXTENSION_TOKEN: optionalText,
  /** CDP mode: Chrome DevTools Protocol endpoint (`pnpm browser:chrome` listens on 9333). */
  BROWSER_CDP_URL: z.string().url().default('http://127.0.0.1:9333'),
  EXECUTE_BROWSER_MCP: z.enum(['playwright', 'agent-browser']).default('playwright'),
  QA_BROWSER_MCP: z.enum(['playwright', 'agent-browser']).default('playwright'),

  DEFAULT_SHOP: z.string().default('karashynyard'),

  DASHBOARD_HOST: loopbackHost,
  DASHBOARD_PORT: port(41010),
  /** 0 disables sending events to the built-in dashboard hub. */
  DASHBOARD_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== '0' && v?.toLowerCase() !== 'false'),

  /** OTLP/HTTP endpoint (ClawMetry listens on :8900). Empty disables OpenTelemetry export. */
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default('http://127.0.0.1:8900'),
  CLAWMETRY_URL: z.string().default('http://127.0.0.1:8900'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  RUNTIME_DIR: z.string().default('.runtime'),
  /** Dashboard journal days and browser run folders older than this are deleted on start. 0 keeps everything. */
  RUNTIME_RETENTION_DAYS: z.coerce.number().int().min(0).default(14),
}).superRefine((e, ctx) => {
  if (e.BROWSER_MODE !== 'extension') return;
  for (const key of ['EXECUTE_BROWSER_MCP', 'QA_BROWSER_MCP'] as const) {
    if (e[key] === 'agent-browser') {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: `agent-browser connects over CDP only: set ${key}=playwright, or BROWSER_MODE=cdp to use it`,
      });
    }
  }
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

/** Absolute runtime directory (sessions, logs, browser artifacts). */
export function runtimeDir(...segments: string[]): string {
  return path.resolve(ROOT_DIR, env().RUNTIME_DIR, ...segments);
}

/** Test hook: forget the cached env so tests can change process.env. */
export function resetEnvCache(): void {
  cached = undefined;
}
