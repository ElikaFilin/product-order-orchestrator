/**
 * Everything the plugin's tools and hooks share. OpenClaw instantiates the plugin module once per registration
 * (startup, discovery, ...) in the same process, so the runtime lives on globalThis: a question a child records in
 * one module instance must be visible to the hook that relays it in another.
 */
import type { SubAgentName } from '../core/agents.js';
import type { HelperCall, ToolGuard } from '../core/browser/guard.js';
import type { PageOps } from '../core/execute/result.js';
import { ProductList } from '../core/explore/product-list.js';
import { ensureMemoryFile } from '../core/memory.js';
import type { PageReads } from '../core/qa/report.js';
import { getShop } from '../core/shops/index.js';
import { defaultStateFile, type PluginConfig } from './config.js';
import type { CosSettings } from './cos.js';
import type { PluginLogger } from './host.js';
import { Store } from './store.js';

export interface Runtime {
  config: PluginConfig;
  store: Store;
  productList: ProductList;
  settings: CosSettings;
  log: PluginLogger;
  /** Browser guards per child run (`sessionKey|runId`): each run opens its own tab. */
  guards: Map<string, ToolGuard>;
  /** Helper calls in flight, by tool call id, so their results can be captured. */
  helperCalls: Map<string, { taskId: string; call: HelperCall }>;
  /** What the page returned during a task (Execute: setQty/readCart; QA: readModal/readCart). */
  pageOps: Map<string, PageOps>;
  pageReads: Map<string, PageReads>;
  /** COS message calls that relay a question, and sessions_send calls that deliver an answer, by tool call id. */
  relays: Map<string, string>;
  sends: Map<string, string>;
}

export function createRuntime(config: PluginConfig, log: PluginLogger, opts: { now?: () => Date } = {}): Runtime {
  const shop = getShop(config.shopId);
  if (config.memoryFile) ensureMemoryFile(config.memoryFile);
  const basketBrowser =
    config.basketBrowser ??
    (config.browserMode === 'extension'
      ? 'the Chrome profile that has the Playwright Extension (if the link opens elsewhere, open it there)'
      : 'the Chrome window the agents use (the `pnpm browser:chrome` window), not your everyday browser');
  return {
    config,
    store: new Store(config.stateFile ?? defaultStateFile(), config.shopId, opts.now),
    productList: new ProductList(config.skillFile),
    settings: {
      cartUrl: shop.cartUrl,
      basketBrowser,
      runTimeoutSeconds: config.runTimeoutSeconds as Record<SubAgentName, number>,
    },
    log,
    guards: new Map(),
    helperCalls: new Map(),
    pageOps: new Map(),
    pageReads: new Map(),
    relays: new Map(),
    sends: new Map(),
  };
}

const RUNTIME = Symbol.for('product-order-orchestrator.runtime');

/** The process-wide runtime, created on first use with the first config seen. */
export function sharedRuntime(config: PluginConfig, log: PluginLogger): Runtime {
  const g = globalThis as { [RUNTIME]?: Runtime };
  g[RUNTIME] ??= createRuntime(config, log);
  return g[RUNTIME];
}
