import { AgentTaskError } from '../shared/task-executor.js';
import { karashynyard } from './karashynyard/index.js';
import type { ShopAdapter } from './types.js';

export type { ShopAdapter } from './types.js';

/** Registered shops. Add a new shop by implementing ShopAdapter in src/shops/<id>/ and listing it here. */
const SHOPS: ReadonlyMap<string, ShopAdapter> = new Map([[karashynyard.id, karashynyard]]);

export function getShop(id: string): ShopAdapter {
  const shop = SHOPS.get(id);
  if (!shop) {
    throw new AgentTaskError('INVALID_REQUEST', `Unknown shop "${id}". Known shops: ${[...SHOPS.keys()].join(', ')}`);
  }
  return shop;
}

export function listShops(): ShopAdapter[] {
  return [...SHOPS.values()];
}
