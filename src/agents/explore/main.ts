import { runMain, serveSubAgent } from '../../shared/sub-agent.js';
import { ExploreExecutor } from './executor.js';

runMain('explore', () =>
  serveSubAgent(
    'explore',
    [
      {
        id: 'choose-products',
        name: 'Choose products',
        description:
          'Asks the user (through COS, INPUT_REQUIRED) which products from the shop product list to buy and how many, ' +
          'and returns a Selection artifact with exact product names. Input: explore-request {action:"select-products", shopId}.',
        tags: ['shopping', 'selection'],
        examples: ['хочу замовити', 'order groceries'],
      },
      {
        id: 'update-product-list',
        name: 'Update product list',
        description:
          'Adds products to or removes products from the shop product list, so the next selection question includes them. ' +
          'Input: explore-request {action:"update-product-list", shopId, add[], remove[]}. Returns a ProductListUpdate artifact.',
        tags: ['product-list'],
        examples: ['save info - add "Котлети по-київськи з індички, 900 г" to product list selection'],
      },
    ],
    (telemetry) => new ExploreExecutor(telemetry),
  ),
);
