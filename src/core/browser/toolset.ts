/**
 * The Playwright MCP tools Execute and QA may call, as their host names them. OpenClaw names MCP tools
 * `<server>__<tool>` (`playwright__browser_click`); the prefix is a parameter so the guards do not depend on it.
 * The browser that holds the basket is reached through the Playwright Extension in the user's Chrome profile
 * (extension mode) or over CDP (smoke test and e2e).
 */

export type BrowserRole = 'execute' | 'qa';
export type BrowserMode = 'extension' | 'cdp';

/** Name of the Playwright MCP server in the OpenClaw config. */
export const PLAYWRIGHT_SERVER = 'playwright';
/** How OpenClaw prefixes the server's tools. */
export const OPENCLAW_TOOL_PREFIX = `${PLAYWRIGHT_SERVER}__`;

/**
 * Tools an agent may use: open its own tab, look, wait, and run the shop helper. Nothing types, presses keys or
 * fills forms (the basket changes only through the helper), and nothing lists, selects or closes the user's tabs.
 * Excluded too: run_code_unsafe, file_upload, drag/drop, dialogs, resize.
 */
export const EXECUTE_BROWSER_TOOLS = [
  'browser_tabs',
  'browser_navigate',
  'browser_snapshot',
  'browser_wait_for',
  'browser_evaluate',
  'browser_take_screenshot',
  'browser_console_messages',
] as const;

/** Only QA clicks, and only the basket icon (its guard checks the selector). */
export const QA_BROWSER_TOOLS = [...EXECUTE_BROWSER_TOOLS, 'browser_click'] as const;

export function browserToolNames(role: BrowserRole): readonly string[] {
  return role === 'qa' ? QA_BROWSER_TOOLS : EXECUTE_BROWSER_TOOLS;
}

export interface BrowserToolset {
  /** Prefix of every tool name of the server (`playwright__`). */
  prefix: string;
  /** Exact tool names the agent is allowed to call. */
  allowedTools: string[];
  /** Tool that runs JavaScript in the page and the input field holding the code. */
  evalTool: { name: string; codeField: 'function' };
  /** Tool that clicks an element and the input field holding its selector. */
  clickTool: { name: string; selectorField: 'target' };
  /**
   * The session's current tab already belongs to this run: the connect page the Playwright Extension opens for each
   * connection. Attached over CDP, Playwright starts on one of the USER's tabs.
   */
  startsInOwnTab: boolean;
  /**
   * The session sees only tabs opened for it: through the extension a connection is limited to its own tab group.
   * Only then may the run close its (current) tab when it is done.
   */
  seesOnlyOwnTabs: boolean;
  /** Fully-qualified tool name. */
  tool(name: string): string;
}

export function browserToolset(opts: { role: BrowserRole; mode: BrowserMode; prefix?: string }): BrowserToolset {
  const prefix = opts.prefix ?? OPENCLAW_TOOL_PREFIX;
  const tool = (name: string) => `${prefix}${name}`;
  return {
    prefix,
    allowedTools: browserToolNames(opts.role).map(tool),
    evalTool: { name: tool('browser_evaluate'), codeField: 'function' },
    clickTool: { name: tool('browser_click'), selectorField: 'target' },
    startsInOwnTab: opts.mode === 'extension',
    seesOnlyOwnTabs: opts.mode === 'extension',
    tool,
  };
}

/**
 * What a Playwright MCP tool call returned: the "### Result" value, JSON-parsed when possible, else the text.
 * Accepts content blocks, an MCP CallToolResult or a plain string.
 */
export function toolResultValue(response: unknown): unknown {
  const r = (response && typeof response === 'object' ? response : {}) as { content?: unknown };
  const blocks: unknown[] = Array.isArray(response) ? response : Array.isArray(r.content) ? r.content : [];
  const text =
    typeof response === 'string'
      ? response
      : blocks
          .flatMap((b) => {
            const block = b as { type?: unknown; text?: unknown };
            return block.type === 'text' && typeof block.text === 'string' ? [block.text] : [];
          })
          .join('\n');
  const match = text.match(/### Result\s*\n([\s\S]*?)(?:\n### |$)/);
  return match ? parseJsonOr(match[1]!.trim()) : text;
}

function parseJsonOr(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
