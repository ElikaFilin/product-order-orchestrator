import { parsePluginConfig, PLUGIN_ID } from './config.js';
import type { PluginHost } from './host.js';
import { registerHooks } from './hooks.js';
import { sharedRuntime, type Runtime } from './runtime.js';
import { registerTools } from './tools.js';

/** Register every tool and hook on `host`; `runtime` is injected by tests, else shared by the whole process. */
export function setupPlugin(host: PluginHost, runtime?: Runtime): Runtime {
  const rt = runtime ?? sharedRuntime(parsePluginConfig(host.pluginConfig), host.logger);
  registerTools(host, rt);
  registerHooks(host, rt);
  return rt;
}

export { PLUGIN_ID };
