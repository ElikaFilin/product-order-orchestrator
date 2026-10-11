/**
 * Data contracts between COS and the sub-agents: the requests built from the order state and the results the
 * sub-agents submit. Every payload has a `type` discriminator.
 */
import { z } from 'zod';

export const ShopId = z.string().min(1);

const Qty = z.number().int().min(0).max(99);
const PositiveQty = z.number().int().min(1).max(99);

/** One product and quantity, identified by its exact display name in the shop. */
export const BasketItem = z.object({
  name: z.string().min(1),
  qty: PositiveQty,
  sku: z.string().optional(),
});
export type BasketItem = z.infer<typeof BasketItem>;

/** A line as it appears in the shop basket. */
export const CartLine = z.object({
  name: z.string().min(1),
  qty: Qty,
  unitPrice: z.number().nonnegative().optional(),
  amount: z.number().nonnegative().optional(),
  sku: z.string().optional(),
});
export type CartLine = z.infer<typeof CartLine>;

// ---------- Explore ----------

export const ExploreRequest = z.discriminatedUnion('action', [
  z.object({
    type: z.literal('explore-request'),
    action: z.literal('select-products'),
    shopId: ShopId,
    /** The user adds products to an order that already has a selection: the result is added to it, not replacing it. */
    merge: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('explore-request'),
    action: z.literal('update-product-list'),
    shopId: ShopId,
    add: z.array(z.string().min(1)).default([]),
    remove: z.array(z.string().min(1)).default([]),
  }),
]);
export type ExploreRequest = z.infer<typeof ExploreRequest>;

/** Explore result: what the user chose to buy. */
export const Selection = z.object({
  type: z.literal('selection'),
  shopId: ShopId,
  items: z.array(BasketItem).min(1),
  notes: z.string().optional(),
});
export type Selection = z.infer<typeof Selection>;

/** Explore result: the product-list skill was changed. */
export const ProductListUpdate = z.object({
  type: z.literal('product-list-update'),
  shopId: ShopId,
  added: z.array(z.string()),
  removed: z.array(z.string()),
  products: z.array(z.string()),
});
export type ProductListUpdate = z.infer<typeof ProductListUpdate>;

// ---------- Order form ----------

/** The user's details for the shop's order form (.env). Agents never type them: code puts them into the page. */
export const CheckoutDetails = z.object({
  name: z.string().min(1),
  /** International format, digits only after the "+": +380671234567. */
  phone: z.string().regex(/^\+\d{8,15}$/, 'phone must be in international format, e.g. +380671234567'),
  /** The delivery option exactly as the shop shows it. */
  delivery: z.string().min(1),
  /** Delivery address or post office. */
  address: z.string().min(1),
});
export type CheckoutDetails = z.infer<typeof CheckoutDetails>;

export const ORDER_FORM_FIELDS = ['name', 'phone', 'delivery', 'address'] as const;

/** The order form in Execute's tab, read back from the page and compared with CheckoutDetails in code. */
export const OrderFormCheck = z.object({
  /** unverified: no read-back of the form after the last basket change (or none at all). */
  status: z.enum(['ok', 'mismatch', 'unverified']),
  fields: z.array(z.object({ field: z.enum(ORDER_FORM_FIELDS), expected: z.string(), actual: z.string(), ok: z.boolean() })),
  detail: z.string().optional(),
});
export type OrderFormCheck = z.infer<typeof OrderFormCheck>;

// ---------- Execute ----------

/** "Make the basket contain exactly targetQty of this product" (0 = remove it). Idempotent by design. */
export const BasketOp = z.object({
  name: z.string().min(1),
  targetQty: Qty,
  sku: z.string().optional(),
});
export type BasketOp = z.infer<typeof BasketOp>;

export const ExecuteRequest = z.object({
  type: z.literal('execute-request'),
  shopId: ShopId,
  mode: z.enum(['initial', 'fix']),
  ops: z.array(BasketOp).min(1),
});
export type ExecuteRequest = z.infer<typeof ExecuteRequest>;

export const OpStatus = z.enum(['ok', 'not_found', 'failed', 'skipped']);

export const ExecuteResult = z.object({
  type: z.literal('execute-result'),
  shopId: ShopId,
  cartUrl: z.string(),
  ops: z.array(
    BasketOp.extend({
      status: OpStatus,
      actualQty: Qty.optional(),
      detail: z.string().optional(),
    }),
  ),
  cart: z.array(CartLine).default([]),
  /** Present when the user's checkout details are configured: Execute filled the order form in its tab. */
  orderForm: OrderFormCheck.optional(),
  notes: z.string().optional(),
});
export type ExecuteResult = z.infer<typeof ExecuteResult>;

// ---------- QA ----------

export const QaFocus = z.object({
  name: z.string().min(1),
  check: z.enum(['quantity', 'present', 'absent']),
  expectedQty: Qty.optional(),
});
export type QaFocus = z.infer<typeof QaFocus>;

export const QaRequest = z.object({
  type: z.literal('qa-request'),
  shopId: ShopId,
  expected: z.array(BasketItem),
  focus: z.array(QaFocus).default([]),
  /**
   * The order form check of the last Execute run. The form lives only in Execute's tab, which QA's own tab cannot
   * see, so code checked it from the page and QA's result carries it.
   */
  orderForm: OrderFormCheck.optional(),
});
export type QaRequest = z.infer<typeof QaRequest>;

export const Difference = z.object({
  kind: z.enum(['missing', 'extra', 'quantity']),
  name: z.string(),
  expectedQty: Qty,
  actualQty: Qty,
});
export type Difference = z.infer<typeof Difference>;

export const QaResult = z.object({
  type: z.literal('qa-result'),
  shopId: ShopId,
  verdict: z.enum(['match', 'mismatch']),
  /** QA read the open basket window (the user's view); false = the lines come from the browser storage only. */
  modalOpened: z.boolean(),
  cart: z.array(CartLine),
  total: z.number().nonnegative().optional(),
  differences: z.array(Difference),
  focus: z.array(QaFocus.extend({ passed: z.boolean(), actualQty: Qty })).default([]),
  /** The order form in Execute's tab (from the request); anything but "ok" makes the verdict a mismatch. */
  orderForm: OrderFormCheck.optional(),
  cartUrl: z.string(),
  notes: z.string().optional(),
});
export type QaResult = z.infer<typeof QaResult>;

// ---------- Errors ----------

export const ErrorCode = z.enum([
  'BROWSER_NOT_CONNECTED',
  'INVALID_REQUEST',
  'LLM_ERROR',
  'BUDGET_EXCEEDED',
  'CANCELED',
  'SESSION_LOST',
  'INTERNAL',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const AgentErrorPayload = z.object({
  type: z.literal('error'),
  code: ErrorCode,
  message: z.string(),
  hint: z.string().optional(),
});
export type AgentErrorPayload = z.infer<typeof AgentErrorPayload>;

/** Question a sub-agent needs the human to answer (carried in an INPUT_REQUIRED status message). */
export const UserQuestion = z.object({
  type: z.literal('user-question'),
  question: z.string().min(1),
  options: z.array(z.string()).optional(),
});
export type UserQuestion = z.infer<typeof UserQuestion>;

/** Pick the first payload in `items` that matches `schema`. */
export function pickPayload<T>(items: readonly unknown[], schema: z.ZodType<T>): T | undefined {
  for (const item of items) {
    const parsed = schema.safeParse(item);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

/**
 * Canonical form of a product name for comparisons: case-insensitive, whitespace collapsed,
 * typographic apostrophes and dashes unified. Display names are never rewritten.
 */
export function normalizeName(name: string): string {
  return name
    .normalize('NFC')
    .replace(/[’ʼ`‘]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
