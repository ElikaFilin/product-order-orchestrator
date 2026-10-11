/**
 * Result shapes of the in-page helper methods the agents' code reads back (every shop's `window.__poo` must
 * return these). Agents report in their own words; code takes these values from the tool results instead.
 */
import { z } from 'zod';

/** `readModal()`: the basket window as the user sees it. */
export const ModalRead = z.object({
  open: z.boolean(),
  lines: z.array(z.object({ name: z.string().min(1), qty: z.number().int().min(0), amount: z.number().nullable().optional() })),
  total: z.number().nullable().optional(),
});
export type ModalRead = z.infer<typeof ModalRead>;

/** `readCart()`: the basket as the shop stores it. */
export const CartRead = z.object({
  lines: z.array(
    z.object({
      name: z.string().min(1),
      qty: z.number().int().min(0),
      unitPrice: z.number().optional(),
      amount: z.number().optional(),
      sku: z.string().optional(),
    }),
  ),
  total: z.number().optional(),
});
export type CartRead = z.infer<typeof CartRead>;

/** `setQty(name, qty)`: what one basket change did. */
export const SetQtyRead = z.object({
  status: z.enum(['ok', 'not_found', 'failed']),
  name: z.string(),
  before: z.number().int(),
  after: z.number().int(),
  detail: z.string().optional(),
});
export type SetQtyRead = z.infer<typeof SetQtyRead>;
