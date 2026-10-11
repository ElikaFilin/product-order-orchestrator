/**
 * The task text a child gets, written by the plugin (COS's sessions_spawn only names the task): the request, COS's
 * instruction, the product question rendered from the skill table, the shop playbook, and any earlier
 * question and answer when a task continues in a new session. Also the message that carries an answer back.
 */
import { browserToolset } from '../core/browser/toolset.js';
import { buildExecutePrompt } from '../core/execute/request.js';
import { SKILL_NAME, type ProductList } from '../core/explore/product-list.js';
import { productQuestion } from '../core/explore/selection.js';
import { buildQaPrompt } from '../core/qa/request.js';
import { getShop } from '../core/shops/index.js';
import type { BrowserMode } from '../core/browser/toolset.js';
import type { TaskRecord } from './store.js';

export interface TaskTextDeps {
  productList: Pick<ProductList, 'read'>;
  browserMode: BrowserMode;
  browserToolPrefix: string;
  /** The user's checkout details are configured: Execute fills the order form. */
  fillOrderForm: boolean;
}

const ASK =
  'If you need the user to decide something, call poo_ask_user with one clear question and end your run with one line ' +
  'saying that you wait for the answer. The answer arrives in this session.';

export function taskHeader(task: TaskRecord): string {
  return `[poo-task ${task.id}] ${task.agent} task of order ${task.orderId}.`;
}

export async function spawnTaskText(task: TaskRecord, deps: TaskTextDeps): Promise<string> {
  const parts = [taskHeader(task), await body(task, deps), ...continuation(task)];
  return parts.filter(Boolean).join('\n\n');
}

/** The sessions_send message that gives the child the user's answer. */
export function answerMessage(task: TaskRecord, answer: string): string {
  return [
    `[poo-task ${task.id}] The user answered your question. Their answer, verbatim:`,
    '"""',
    answer,
    '"""',
    'Continue the task from where you stopped.',
  ].join('\n');
}

async function body(task: TaskRecord, deps: TaskTextDeps): Promise<string> {
  const request = task.request;
  const cos = task.instruction.trim() ? `Message from the Chief of Staff:\n${task.instruction.trim()}` : '';
  switch (request.type) {
    case 'explore-request': {
      if (request.action === 'update-product-list') {
        return [
          `Task: update-product-list for shop "${request.shopId}".`,
          `Add: ${JSON.stringify(request.add)}. Remove: ${JSON.stringify(request.remove)}.`,
          cos,
          `Read your ${SKILL_NAME} skill first, then follow its "B. update-product-list" procedure. Change the list only ` +
            'with poo_update_product_list. Finish with one line saying what changed.',
          ASK,
        ]
          .filter(Boolean)
          .join('\n\n');
      }
      const products = await deps.productList.read(request.shopId);
      const standing = request.standing ?? [];
      const always = standing.length
        ? `Every-order products: ${standing.map((i) => `${i.name} × ${i.qty}`).join('; ')}. The user asked to have them in ` +
          'every order; code adds them to your selection, so never submit or ask about them. The question already says so. ' +
          'An answer that selects nothing else ("0", "нічого") means only these products: submit outcome "selected" with no items.'
        : '';
      const merge = request.merge
        ? 'Merge: the user adds products to an order that already has a selection (the result is added to it). ' +
          'If the message from the Chief of Staff already names the products (numbers or names) and quantities, read them by ' +
          'the procedure without asking the full question; ask only about unclear lines. If it names none, ask the full question.'
        : '';
      return [
        `Task: select-products for shop "${request.shopId}".`,
        cos,
        merge,
        always,
        `Read your ${SKILL_NAME} skill first, then follow its "A. select-products" procedure.`,
        // Rendered in code from the skill's table, so the numbers the user sees are exactly the table rows.
        'The product question (its numbers are the table\'s # column). Send it with poo_ask_user word for word, then end your run:',
        `"""\n${productQuestion(products, standing)}\n"""`,
        'When the answer arrives in this session, read it by the procedure and call poo_submit_selection with the rows ' +
          'the user chose (outcome "canceled" only if the user confirmed they want nothing).',
      ]
        .filter(Boolean)
        .join('\n\n');
    }
    case 'execute-request': {
      const shop = getShop(request.shopId);
      const tools = browserToolset({ role: 'execute', mode: deps.browserMode, prefix: deps.browserToolPrefix });
      const playbook = shop.executePlaybook(tools, { fillOrderForm: deps.fillOrderForm, clearBasket: request.clearBasket === true });
      return [buildExecutePrompt(request, shop, task.instruction), playbook, ASK].join('\n\n');
    }
    case 'qa-request': {
      const shop = getShop(request.shopId);
      const tools = browserToolset({ role: 'qa', mode: deps.browserMode, prefix: deps.browserToolPrefix });
      return [
        buildQaPrompt(request, shop, task.instruction),
        shop.qaPlaybook(tools),
        'Finish by calling poo_submit_qa with what you observed: whether the basket window opened, where the lines come ' +
          'from, every line, and the total.',
        ASK,
      ].join('\n\n');
    }
  }
}

/** Earlier questions and answers of a task that continues in a new session. */
function continuation(task: TaskRecord): string[] {
  const answered = task.questions.filter((q) => q.answer !== undefined);
  if (task.spawns === 0 || answered.length === 0) return [];
  return [
    'This task continues in a new session. Earlier in this task:',
    ...answered.map((q) => `You asked the user:\n"""\n${q.question}\n"""\nThe user answered:\n"""\n${q.answer}\n"""`),
    'Continue the task from there; do not ask these questions again.',
  ];
}
