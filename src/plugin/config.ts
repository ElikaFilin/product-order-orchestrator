import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { OPENCLAW_TOOL_PREFIX } from '../core/browser/toolset.js';

export const PLUGIN_ID = 'product-order-orchestrator';

const seconds = (fallback: number) => z.number().int().min(30).max(3600).default(fallback);

/** `plugins.entries.product-order-orchestrator.config` (the manifest's configSchema mirrors it). */
export const PluginConfig = z.object({
  /** Absolute path of Explore's ask-what-to-buy SKILL.md (its product tables). */
  skillFile: z.string().min(1),
  /** Numeric Telegram user id of the owner: COS may message only this chat. */
  telegramUserId: z.union([z.number().int(), z.string().regex(/^\d+$/)]).transform(String),
  shopId: z.string().min(1).default('karashynyard'),
  /** How Playwright MCP reaches Chrome: the user's profile through the extension, or CDP (smoke test, e2e). */
  browserMode: z.enum(['extension', 'cdp']).default('extension'),
  /** Prefix OpenClaw gives the Playwright MCP server's tools. */
  browserToolPrefix: z.string().min(1).default(OPENCLAW_TOOL_PREFIX),
  /** Where the basket link must be opened, as COS tells the user ("Chrome, in your "Home" profile"). */
  basketBrowser: z.string().min(1).optional(),
  /** Where the order and the tasks are kept between gateway restarts. */
  stateFile: z.string().min(1).optional(),
  /** Longest run of one sub-agent task (a run ends when the agent asks the user, so these are short). */
  runTimeoutSeconds: z
    .object({ explore: seconds(300), execute: seconds(900), qa: seconds(600) })
    .default({ explore: 300, execute: 900, qa: 600 }),
});
export type PluginConfig = z.infer<typeof PluginConfig>;

export function parsePluginConfig(raw: unknown): PluginConfig {
  const parsed = PluginConfig.safeParse(raw ?? {});
  if (!parsed.success) throw new Error(`Invalid ${PLUGIN_ID} plugin config:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export function defaultStateFile(env: NodeJS.ProcessEnv = process.env): string {
  const stateDir = env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), '.openclaw');
  return path.join(stateDir, PLUGIN_ID, 'state.json');
}
