import type { ShopAdapter } from '../types.js';
import { HELPER_SOURCE } from './helper.js';
import { CART_ICON, HEADER_CART_ICON, renderExecutePlaybook, renderQaPlaybook, type ShopUrls } from './playbooks.js';

const URLS: ShopUrls = {
  baseUrl: 'https://karashynyard.com.ua/',
  // On a full page load Tilda opens the cart window for this hash (when the basket is not empty).
  cartUrl: 'https://karashynyard.com.ua/#opencart',
};

/** Karashyn Yard farm shop: a Tilda site with T776 product cards and the T706 localStorage cart. */
export const karashynyard: ShopAdapter = {
  id: 'karashynyard',
  name: 'Karashyn Yard (karashynyard.com.ua)',
  ...URLS,
  allowedOrigins: ['https://karashynyard.com.ua'],
  // tilda-forms posts orders to forms.tildaapi.<data-tilda-root-zone> ("one" here), falls back to forms2.tildacdn.com;
  // the rest are Tilda's defaults.
  blockedOrigins: ['https://forms.tildaapi.one', 'https://forms.tildacdn.com', 'https://forms2.tildacdn.com', 'https://forms.tildaapi.com'],
  forbiddenPatterns: [
    /t706__orderform/i, // the checkout form inside the cart window
    /Відправити\s+замовлення/i, // its submit button
    /submit/i, // submit buttons, form.submit(), requestSubmit()
    /form\d{6,}/i, // the form id (form638772399)
    /\bt-form|js-form|tildaForm/i, // Tilda form markup and the tildaForm JS API
    /forms2?\.tilda/i, // order endpoints
    /\bt-input|\bt-radio|\bt-checkbox|t-img-select/i, // checkout form inputs
    /Ваше\s+ім|номер\s+телефону|Нової\s+пошти|Новою\s+поштою|тушонку/i, // checkout field labels
  ],
  helperSource: HELPER_SOURCE,
  helperApi: { read: ['status', 'find', 'readCart', 'readModal'], write: ['setQty'] },
  cartOpeners: [CART_ICON, HEADER_CART_ICON],
  executePlaybook: (tools) => renderExecutePlaybook(tools, URLS),
  qaPlaybook: (tools) => renderQaPlaybook(tools, URLS),
};
