import type { BrowserToolset } from '../browser/toolset.js';

export interface ExecutePlaybookOptions {
  /** The user's checkout details are configured: Execute fills the order form and keeps its tab, where the form lives. */
  fillOrderForm?: boolean;
  /** The first basket change of a new order: remove the lines of earlier orders before the operations. */
  clearBasket?: boolean;
}

/**
 * Everything shop-specific lives behind this interface, so adding a shop = adding a folder under
 * src/core/shops/<id>/ and a product-list section in the Explore skill. Agents stay generic.
 */
export interface ShopAdapter {
  id: string;
  name: string;
  /** Home page the agents open. */
  baseUrl: string;
  /** Link that opens the prepared basket in the browser profile that holds it. */
  cartUrl: string;
  /** Origins agents may navigate to (anything else is denied by the guard). */
  allowedOrigins: string[];
  /** Network origins that must never be reached by an agent tab (checkout/order endpoints). */
  blockedOrigins: string[];
  /** Tool inputs matching any of these are denied (checkout form, submit buttons, ...). */
  forbiddenPatterns: RegExp[];
  /**
   * JavaScript statements that idempotently define `window.__poo` (the in-page helper API used by
   * the playbooks). The guard prepends it to every eval call, so agents never paste it.
   */
  helperSource: string;
  /**
   * `window.__poo` methods agents may call; a page script is one such call and nothing else. `write` methods
   * change the basket or fill the order form (Execute only); QA may call `read` ones. Filling the order form needs
   * `fillOrderForm(name, phone, delivery, address)` (the guard writes its arguments) and `readOrderForm()`, both
   * returning OrderFormRead.
   */
  helperApi: { read: string[]; write: string[] };
  /** Selectors of the controls that open the basket window the way the user does (the only clicks QA may make). */
  cartOpeners: string[];
  /** Markdown appended to the Execute agent's system prompt. */
  executePlaybook(tools: BrowserToolset, opts?: ExecutePlaybookOptions): string;
  /** Markdown appended to the QA agent's system prompt. */
  qaPlaybook(tools: BrowserToolset): string;
}
