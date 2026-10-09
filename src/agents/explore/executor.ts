/**
 * Explore agent: asks the human (through COS) which products to buy, and maintains the product
 * list inside its ask-what-to-buy skill. Its only tools are that skill, ask_user and, in
 * update-product-list tasks, update_product_list.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { agentHome } from '../../config/agents.js';
import { env } from '../../config/env.js';
import type { Telemetry } from '../../observability/telemetry.js';
import { runAgent, type ToolGuard } from '../../shared/claude.js';
import { ExploreRequest, pickPayload, type ProductListUpdate } from '../../shared/contracts.js';
import { askUserTool } from '../../shared/sub-agent.js';
import { AgentTaskError, LongLivedExecutor, type TaskOutcome, type TaskRunContext } from '../../shared/task-executor.js';
import { ProductList, SKILL_NAME, type Product, type ProductListChange } from './product-list.js';
import { productQuestion, selectionFromRows } from './selection.js';
import { updateProductListTool } from './tools.js';

export type AgentRunner = typeof runAgent;

type SelectRequest = Extract<ExploreRequest, { action: 'select-products' }>;
type UpdateRequest = Extract<ExploreRequest, { action: 'update-product-list' }>;

type McpTools = NonNullable<Parameters<typeof createSdkMcpServer>[0]['tools']>;

const MCP_SERVER = 'explore';
const MAX_TURNS = 16;

// The model's final answers. The CLI turns an output schema into its StructuredOutput tool's
// input_schema, so the root must be an object (no top-level union). The executor builds the
// contract payloads from these, so the model never retypes the product list.
const SelectedItem = z.object({
  row: z.number().int().min(1).describe('The product number the user chose: the table # (the number in the question)'),
  name: z.string().min(1).describe('That product name, copied from the table (a cross-check of `row`)'),
  qty: z.number().int().min(1).max(99),
});
const SelectOutput = z.object({
  outcome: z.enum(['selected', 'canceled']).describe('"canceled" only when the user confirmed they want nothing'),
  items: z.array(SelectedItem).describe('Selected products by table row; empty when canceled'),
  notes: z.string().optional().describe('Anything COS should know, e.g. answer lines that were dropped and why'),
});
const UpdateOutput = z.object({
  notes: z.string().optional().describe('Anything COS should know, e.g. a name the user did not want removed after all'),
});

export class ExploreExecutor extends LongLivedExecutor {
  constructor(
    telemetry: Telemetry,
    private readonly runner: AgentRunner = runAgent,
    private readonly productList = new ProductList(),
  ) {
    super('explore', telemetry);
  }

  protected async run(ctx: TaskRunContext): Promise<TaskOutcome> {
    const request = parseRequest(ctx.data);
    const products = await this.productList.read(request.shopId); // fails fast for a shop without a list
    return request.action === 'select-products'
      ? this.selectProducts(ctx, request, products)
      : this.updateProductList(ctx, request);
  }

  private async selectProducts(ctx: TaskRunContext, request: SelectRequest, products: Product[]): Promise<TaskOutcome> {
    const output = await this.runModel(ctx, request, SelectOutput, [askUserTool(ctx)], productQuestion(products));
    if (output.outcome === 'canceled') {
      throw new AgentTaskError('CANCELED', `The user chose not to buy anything.${output.notes ? ` ${output.notes}` : ''}`);
    }
    if (output.items.length === 0) throw new AgentTaskError('LLM_ERROR', 'The agent finished without selecting any product.');

    const selection = selectionFromRows(request.shopId, output.items, products, output.notes);
    const lines = selection.items.map((i) => `${i.name} × ${i.qty}`).join('; ');
    return {
      summary: `Selected ${selection.items.length} product(s): ${lines}.${selection.notes ? ` Notes: ${selection.notes}` : ''}`,
      result: selection,
      artifactName: 'selection',
    };
  }

  private async updateProductList(ctx: TaskRunContext, request: UpdateRequest): Promise<TaskOutcome> {
    const applied: ProductListChange[] = [];
    const tools = [askUserTool(ctx), updateProductListTool(request.shopId, this.productList, applied)];
    const output = await this.runModel(ctx, request, UpdateOutput, tools);

    const products = await this.productList.read(request.shopId);
    const collect = (pick: (c: ProductListChange) => string[]) => [...new Set(applied.flatMap(pick))];
    const result: ProductListUpdate = {
      type: 'product-list-update',
      shopId: request.shopId,
      added: collect((c) => c.added),
      removed: collect((c) => c.removed),
      products: products.map((p) => p.name),
    };
    const skipped = [
      ...collect((c) => c.alreadyListed).map((n) => `already listed: ${n}`),
      ...collect((c) => c.notFound).map((n) => `not in the list: ${n}`),
    ];
    if (result.added.length + result.removed.length > 0) {
      ctx.telemetry.emit(
        'log',
        { level: 'info', text: 'product list updated', shopId: request.shopId, added: result.added, removed: result.removed },
        { taskId: ctx.taskId, contextId: ctx.contextId, traceId: ctx.span.traceId },
      );
    }
    const summary = [
      `Product list "${request.shopId}": ${result.products.length} products.`,
      result.added.length ? `Added: ${result.added.join('; ')}.` : '',
      result.removed.length ? `Removed: ${result.removed.join('; ')}.` : '',
      result.added.length + result.removed.length === 0 ? 'Nothing changed.' : '',
      skipped.length ? `Skipped (${skipped.join('; ')}).` : '',
      output.notes ? `Notes: ${output.notes}` : '',
    ];
    return { summary: summary.filter(Boolean).join(' '), result, artifactName: 'product-list-update' };
  }

  private async runModel<T>(
    ctx: TaskRunContext,
    request: ExploreRequest,
    outputSchema: z.ZodType<T>,
    tools: McpTools,
    question?: string,
  ): Promise<T> {
    const allowedTools = ['Skill', ...tools.map((t) => `mcp__${MCP_SERVER}__${t.name}`)];
    const { structured } = await this.runner({
      agent: 'explore',
      model: env().EXPLORE_MODEL,
      cwd: agentHome('explore'),
      systemPrompt: await systemPrompt(),
      builtInTools: ['Skill'],
      skills: [SKILL_NAME],
      settingSources: ['project'],
      mcpServers: { [MCP_SERVER]: createSdkMcpServer({ name: MCP_SERVER, version: '0.1.0', tools, alwaysLoad: true }) },
      allowedTools,
      guard: guardFor(allowedTools),
      outputSchema,
      maxTurns: MAX_TURNS,
      maxBudgetUsd: env().EXPLORE_MAX_BUDGET_USD,
      telemetry: ctx.telemetry,
      span: ctx.span,
      ids: { taskId: ctx.taskId, contextId: ctx.contextId, traceId: ctx.span.traceId },
      prompt: taskPrompt(request, ctx.instruction, question),
      signal: ctx.signal,
    });
    return structured;
  }
}

/** The explore-request in the message; a message without one means "select products in the default shop". */
function parseRequest(data: readonly unknown[]): ExploreRequest {
  const request = pickPayload(data, ExploreRequest);
  if (request) return request;
  const malformed = data.find((d) => (d as { type?: unknown } | null)?.type === 'explore-request');
  if (malformed !== undefined) {
    const issues = ExploreRequest.safeParse(malformed).error;
    throw new AgentTaskError('INVALID_REQUEST', `Malformed explore-request${issues ? `: ${z.prettifyError(issues)}` : ''}`);
  }
  return { type: 'explore-request', action: 'select-products', shopId: env().DEFAULT_SHOP };
}

async function systemPrompt(): Promise<string> {
  const contract = await readFile(path.join(agentHome('explore'), 'AGENTS.md'), 'utf8');
  return (
    `${contract.trim()}\n\n## This run\n\nYou run unattended inside one task; nobody reads your plain-text replies. ` +
    'Reach the human only through ask_user, and finish with the structured result.'
  );
}

function taskPrompt(request: ExploreRequest, instruction: string, question?: string): string {
  const procedure = request.action === 'select-products' ? 'A. select-products' : 'B. update-product-list';
  const merge =
    request.action === 'select-products' && request.merge
      ? 'Merge: the user adds products to an order that already has a selection (the result is added to it). ' +
        'If the message from COS already names the products (numbers or names) and quantities, read them by step 3 ' +
        'without asking the full question; ask only about unclear lines. If it names none, ask the full question.'
      : '';
  return [
    `Task: ${request.action} for shop "${request.shopId}".`,
    `Request: ${JSON.stringify(request)}`,
    instruction ? `Message from COS:\n${instruction}` : '',
    merge,
    // Rendered in code from the skill's table, so the numbers the user sees are exactly the table rows.
    question ? `The product question (its numbers are the table's # column). Send it with ask_user word for word:\n"""\n${question}\n"""` : '',
    `Load the ${SKILL_NAME} skill first, then follow its "${procedure}" procedure.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Defense in depth behind allowedTools/dontAsk: only our tools, and only our skill. (The shared hook
 * never asks a guard about the CLI's StructuredOutput tool, which carries the final answer.)
 */
function guardFor(allowedTools: readonly string[]): ToolGuard {
  return (toolName, input) => {
    if (!allowedTools.includes(toolName)) return { deny: `${toolName} is not available to the Explore agent.` };
    if (toolName === 'Skill' && String(input.skill ?? '').replace(/^\//, '') !== SKILL_NAME) {
      return { deny: `Only the ${SKILL_NAME} skill is available.` };
    }
    return undefined;
  };
}
