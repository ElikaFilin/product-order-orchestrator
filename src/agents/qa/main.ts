/**
 * QA agent (A2A server). Opens the basket in the user's default browser, reads the cart window and
 * reports what it holds; the verdict against the expected order is computed in code (diff.ts).
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
import { askUserServer, runMain, serveSubAgent } from '../../shared/sub-agent.js';
import { LongLivedExecutor, type TaskOutcome, type TaskRunContext } from '../../shared/task-executor.js';
import { getShop } from '../../shops/index.js';
import { readOnlyBasketGuard } from './guard.js';
import { PageReads, QaObservation, summarizeQa, toQaResult } from './report.js';
import { buildQaPrompt, resolveQaRequest } from './request.js';

/**
 * Open tab, page ready (up to 2), three ways to open the cart window, a bounded wait, three reads, answer:
 * about 14 turns on the worst path of the playbook, plus room for a retry.
 */
const MAX_TURNS = 24;

class QaExecutor extends LongLivedExecutor {
  constructor(telemetry: Telemetry) {
    super('qa', telemetry);
  }

  protected async run(ctx: TaskRunContext): Promise<TaskOutcome> {
    const request = resolveQaRequest(ctx.data);
    const shop = getShop(request.shopId);
    const e = env();
    const connection = browserConnection(e);
    await requireBrowser(connection);

    const outputDir = runtimeDir('runs', ctx.taskId, 'qa');
    await mkdir(outputDir, { recursive: true });
    const toolset = browserToolset(e.QA_BROWSER_MCP, {
      role: 'qa',
      connection,
      outputDir,
      blockedOrigins: shop.blockedOrigins,
      session: `qa-${ctx.taskId.slice(0, 8)}`,
    });
    const lane = await readFile(path.join(agentHome('qa'), 'AGENTS.md'), 'utf8');
    const ids = { taskId: ctx.taskId, contextId: ctx.contextId, traceId: ctx.span.traceId };

    const page = new PageReads();
    const recordPage = (tool: string, input: Record<string, unknown>, response: unknown) => {
      if (tool !== toolset.evalTool.name) return;
      const call = parseHelperCall(String(input[toolset.evalTool.codeField] ?? ''));
      if (call) page.record(call.method, toolResultValue(toolset.kind, response));
    };

    ctx.progress(`Checking the basket against ${request.expected.length} expected line(s).`);
    const { structured: observation } = await runAgent({
      agent: 'qa',
      model: e.QA_MODEL,
      cwd: agentHome('qa'),
      systemPrompt: `${lane}\n\n${shop.qaPlaybook(toolset)}`,
      builtInTools: [],
      mcpServers: { [toolset.serverName]: toolset.server, agent: askUserServer('agent', ctx) },
      allowedTools: [...toolset.allowedTools, 'mcp__agent__ask_user'],
      guard: readOnlyBasketGuard(toolset, shop, createBrowserGuard(shop, toolset)),
      onToolResult: recordPage,
      redactOutput: createTabRedactor(shop, toolset),
      outputSchema: QaObservation,
      prompt: buildQaPrompt(request, shop, ctx.instruction),
      maxTurns: MAX_TURNS,
      maxBudgetUsd: e.QA_MAX_BUDGET_USD,
      signal: ctx.signal,
      telemetry: ctx.telemetry,
      span: ctx.span,
      ids,
    }).finally(() => toolset.cleanup());
    ctx.telemetry.emit(
      'log',
      {
        level: 'info',
        text: 'basket observed',
        modalOpened: observation.modalOpened,
        readVia: observation.readVia,
        lines: observation.lines.length,
        total: observation.total,
        pageWindowRead: Boolean(page.modal),
        pageStorageRead: Boolean(page.cart),
      },
      ids,
    );

    const result = toQaResult(request, observation, shop.cartUrl, page);
    const summary = summarizeQa(result);
    ctx.progress(`Verdict: ${result.verdict}.`);
    return { summary, result, artifactName: 'qa-result' };
  }
}

runMain('qa', () =>
  serveSubAgent(
    'qa',
    [
      {
        id: 'verify-basket',
        name: 'Verify basket',
        description:
          "Opens the shop basket in the user's default browser, reads the order window and reports missing, extra or " +
          'wrong-quantity lines against the expected order (optionally focusing on specific re-checks).',
        tags: ['browser', 'basket', 'qa'],
        examples: ['qa-request {expected:[{name, qty}], focus:[{name, check:"quantity", expectedQty:2}]}'],
      },
    ],
    (telemetry) => new QaExecutor(telemetry),
  ),
);
