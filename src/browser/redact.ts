/**
 * Playwright MCP lists every tab of the attached browser (title and URL) in its responses ("### Open tabs").
 * Attached to the user's own browser, that is their browsing: hide every tab that is not on the shop before
 * the response reaches the model, the dashboard or a transcript. Tab numbers stay, so the list keeps its shape.
 */
import type { ShopAdapter } from '../shops/types.js';
import type { BrowserToolset } from './mcp.js';

const HIDDEN = '[another tab, hidden]';
/** "- 3: (current) [Title](https://url)": the URL is what follows the last "](". */
const TAB_LINE = /^- (\d+): (\(current\) )?\[.*\]\((.*)\)$/;

export function hideForeignTabs(text: string, allowedOrigins: readonly string[]): string {
  const onShop = (url: string) => url === 'about:blank' || allowedOrigins.includes(originOf(url));
  let section = '';
  let hideTitle = false;
  return text
    .split('\n')
    .map((line) => {
      if (line.startsWith('### ')) {
        section = line;
        hideTitle = false;
        return line;
      }
      const tab = line.match(TAB_LINE);
      if (tab) return onShop(tab[3]!) ? line : `- ${tab[1]}: ${tab[2] ?? ''}${HIDDEN}`;
      if (section === '### Open tabs' && line.startsWith('- ')) return `- ${HIDDEN}`;
      if (section === '### Page') {
        const url = line.match(/^- Page URL: (.*)$/);
        if (url && !onShop(url[1]!.trim())) {
          hideTitle = true;
          return `- Page URL: ${HIDDEN}`;
        }
        if (hideTitle && line.startsWith('- Page Title: ')) return `- Page Title: ${HIDDEN}`;
      }
      return line;
    })
    .join('\n');
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/** A `redactOutput` for runAgent: the rewritten Playwright response, or undefined when nothing was hidden. */
export function createTabRedactor(
  shop: Pick<ShopAdapter, 'allowedOrigins'>,
  toolset: Pick<BrowserToolset, 'kind' | 'serverName'>,
): (toolName: string, response: unknown) => unknown {
  const prefix = `mcp__${toolset.serverName}__`;
  return (toolName, response) => {
    if (toolset.kind !== 'playwright' || !toolName.startsWith(prefix) || !Array.isArray(response)) return undefined;
    let changed = false;
    const blocks = response.map((block: unknown) => {
      const b = block as { type?: unknown; text?: unknown };
      if (b?.type !== 'text' || typeof b.text !== 'string') return block;
      const text = hideForeignTabs(b.text, shop.allowedOrigins);
      if (text === b.text) return block;
      changed = true;
      return { ...b, text };
    });
    return changed ? blocks : undefined;
  };
}
