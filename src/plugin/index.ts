/**
 * OpenClaw plugin entry (bundled to openclaw/plugin/dist/index.js). The object has the shape definePluginEntry
 * returns; the SDK is imported for types only, so the bundle does not depend on where OpenClaw is installed.
 */
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import { parsePluginConfig, PLUGIN_ID } from './config.js';
import type { HookHandlers, PluginHost } from './host.js';
import { setupPlugin } from './plugin.js';

export default {
  id: PLUGIN_ID,
  name: 'Product Order Orchestrator',
  description: 'COS, Explore, Execute and QA: tasks, questions, typed results and every safety rule for filling a shop basket.',
  configSchema: {
    safeParse(value: unknown) {
      try {
        return { success: true as const, data: parsePluginConfig(value) };
      } catch (err) {
        return { success: false as const, error: { issues: [{ path: [], message: err instanceof Error ? err.message : String(err) }] } };
      }
    },
  },
  register(api: OpenClawPluginApi) {
    setupPlugin(hostOf(api));
  },
};

function hostOf(api: OpenClawPluginApi): PluginHost {
  return {
    pluginConfig: api.pluginConfig,
    logger: api.logger,
    registerTool: (factory, opts) => api.registerTool(factory, opts),
    registerAgentToolResultMiddleware: (handler, options) => api.registerAgentToolResultMiddleware(handler, options),
    // Each hook's handler type is checked against the SDK in sdkCompatible() below.
    on: (hookName, handler, opts) => (api.on as (name: string, handler: unknown, opts?: unknown) => void)(hookName, handler, opts),
  };
}

/** Compile-time only: our narrowed hook handlers are valid SDK handlers. */
export function sdkCompatible(api: OpenClawPluginApi, h: HookHandlers): void {
  api.on('before_tool_call', h.before_tool_call);
  api.on('after_tool_call', h.after_tool_call);
  api.on('before_prompt_build', h.before_prompt_build);
  api.on('subagent_spawned', h.subagent_spawned);
  api.on('subagent_ended', h.subagent_ended);
  api.on('message_sending', h.message_sending);
  api.on('before_reset', h.before_reset);
}
