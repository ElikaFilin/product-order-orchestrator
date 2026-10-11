/**
 * Deterministic check of the shop's order form: the fields Execute's page returned vs the user's checkout details.
 * The models only fill and read the form through the helper; this code decides whether it is right.
 */
import type { CheckoutDetails, OrderFormCheck } from './contracts.js';
import type { OrderFormRead } from './shops/helper-api.js';

/** Same text after Unicode normalization and whitespace collapsing (case matters: the page holds what was put in). */
const sameText = (a: string, b: string) => clean(a) === clean(b);
const clean = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ').trim();
const digits = (s: string) => s.replace(/\D/g, '');

export function checkOrderForm(expected: CheckoutDetails, form: OrderFormRead): OrderFormCheck {
  if (!form.found) return uncheckedOrderForm(form.detail ?? 'The order form was not found on the page.');
  const fields: OrderFormCheck['fields'] = [
    { field: 'name', expected: expected.name, actual: form.name, ok: sameText(form.name, expected.name) },
    // The shop formats the number ("+380 (67) 123-45-67"): only the digits count.
    { field: 'phone', expected: expected.phone, actual: form.phone, ok: digits(form.phone) === digits(expected.phone) },
    { field: 'delivery', expected: expected.delivery, actual: form.delivery ?? '', ok: sameText(form.delivery ?? '', expected.delivery) },
    { field: 'address', expected: expected.address, actual: form.address, ok: sameText(form.address, expected.address) },
  ];
  const ok = fields.every((f) => f.ok);
  return { status: ok ? 'ok' : 'mismatch', fields, ...(!ok && form.detail ? { detail: form.detail } : {}) };
}

export function uncheckedOrderForm(detail: string): OrderFormCheck {
  return { status: 'unverified', fields: [], detail };
}

/** One line for task summaries and COS's context. */
export function describeOrderForm(check: OrderFormCheck): string {
  switch (check.status) {
    case 'ok':
      return `Order form: filled in Execute's tab and checked (${check.fields.map((f) => f.field).join(', ')}).`;
    case 'mismatch': {
      const wrong = check.fields.filter((f) => !f.ok).map((f) => `${f.field}: expected "${f.expected}", the form has "${f.actual}"`);
      return `Order form differs: ${wrong.join('; ')}.${check.detail ? ` (${check.detail})` : ''}`;
    }
    case 'unverified':
      return `Order form: not checked: ${check.detail ?? 'no read-back from the page'}`;
  }
}
