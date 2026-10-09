/**
 * Execute agent (A2A server). Drives the user's default browser so the shop basket contains the
 * requested products and quantities, then reports per-operation results to COS.
 */
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { browserConnection, requireBrowser } from '../../browser/connection.js';
import { createBrowserGuard, parseHelperCall } from '../../browser/guard.js';
import { browserToolset, toolResultValue } from '../../browser/mcp.js';
import { createTabRedactor } from '../../browser/redact.js';
import { agentHome } from '../../config/agents.js';
import { env, runtimeDir } from '../../config/env.js';
import type { Telemetry } from '../../observability/telemetry.js';
import { runAgent } from '../../shared/claude.js';
import { ExecuteResult } from '../../shared/contracts.js';
import { askUserServer, runMain, serveSubAgent } from '../../shared/sub-agent.js';
import { LongLivedExecutor, type TaskOutcome, type TaskRunContext } from '../../shared/task-executor.js';
import { getShop } from '../../shops/index.js';
import { buildExecutePrompt, maxTurnsFor, resolveExecuteRequest } from './request.js';
import { finalizeExecuteResult, PageOps, summarizeExecute } from './result.js';

class ExecuteExecutor extends LongLivedExecutor {
  constructor(telemetry: Telemetry) {
    super('execute', telemetry);
  }

  protected async run(ctx: TaskRunContext): Promise<TaskOutcome> {
    const request = resolveExecuteRequest(ctx.data);
    const shop = getShop(request.shopId);
    const e = env();
    const connection = browserConnection(e);
    await requireBrowser(connection);

    const outputDir = runtimeDir('runs', ctx.taskId, 'execute');
    await mkdir(outputDir, { recursive: true });
    const toolset = browserToolset(e.EXECUTE_BROWSER_MCP, {
      role: 'execute',
      connection,
      outputDir,
      blockedOrigins: shop.blockedOrigins,
      session: `execute-${ctx.taskId.slice(0, 8)}`,
    });
    const lane = await readFile(path.join(agentHome('execute'), 'AGENTS.md'), 'utf8');
    const ids = { taskId: ctx.taskId, contextId: ctx.contextId, traceId: ctx.span.traceId };

    const page = new PageOps();
    const recordPage = (tool: string, input: Record<string, unknown>, response: unknown) => {
      if (tool !== toolset.evalTool.name) return;
      const call = parseHelperCall(String(input[toolset.evalTool.codeField] ?? ''));
      if (call) page.record(call, toolResultValue(toolset.kind, response));
    };

    ctx.progress(`Updating ${request.ops.length} basket line(s) (${request.mode}).`);
    const { structured } = await runAgent({
      agent: 'execute',
      model: e.EXECUTE_MODEL,
      cwd: agentHome('execute'),
      systemPrompt: `${lane}\n\n${shop.executePlaybook(toolset)}`,
      builtInTools: [],
      mcpServers: { [toolset.serverName]: toolset.server, agent: askUserServer('agent', ctx) },
      allowedTools: [...toolset.allowedTools, 'mcp__agent__ask_user'],
      guard: createBrowserGuard(shop, toolset),
      onToolResult: recordPage,
      redactOutput: createTabRedactor(shop, toolset),
      outputSchema: ExecuteResult,
      prompt: buildExecutePrompt(request, shop, ctx.instruction),
      maxTurns: maxTurnsFor(request),
      maxBudgetUsd: e.EXECUTE_MAX_BUDGET_USD,
      signal: ctx.signal,
      telemetry: ctx.telemetry,
      span: ctx.span,
      ids,
    }).finally(() => toolset.cleanup());

    const result = finalizeExecuteResult(request, structured, shop.cartUrl, page);
    const skipped = result.ops.filter((op) => op.status === 'skipped').map((op) => op.name);
    if (skipped.length) {
      ctx.telemetry.emit('log', { level: 'warn', text: 'operations skipped', ops: skipped }, ids);
    }
    const summary = summarizeExecute(request.mode, result);
    ctx.progress('Browser work finished; reporting to COS.');
    return { summary, result, artifactName: 'execute-result' };
  }
}

runMain('execute', () =>
  serveSubAgent(
    'execute',
    [
      {
        id: 'fill-basket',
        name: 'Fill basket',
        description:
          "Makes the shop basket in the user's default browser contain exactly the requested quantities " +
          '(absolute targets, 0 removes a line) and reports the result of every operation plus the basket contents.',
        tags: ['browser', 'basket', 'execute'],
        examples: ['execute-request {mode:"initial", ops:[{name, targetQty}]}', 'execute-request {mode:"fix", ops:[{name, targetQty:0}]}'],
      },
    ],
    (telemetry) => new ExecuteExecutor(telemetry),
  ),
);
