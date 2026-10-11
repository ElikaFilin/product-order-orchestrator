# Evidence: requirement → proof

Every requirement of the assignment, with where it lives in the code and what shows it working. Collected on
2026-10-11 from this repository, OpenClaw 2026.9.9 and a real Telegram run (models `anthropic/claude-opus-5-5` for COS,
`anthropic/claude-sonnet-5-5` for the sub-agents). Personal data (name, phone, address, Telegram id) is replaced with
`<name>`, `<phone>`, `<address>`, `<owner-id>` or "Owner" in every file here.

| # | Requirement | Verdict | Main proof |
|---|---|---|---|
| 1 | Agents: ≥ 2 agents with different roles, instructions and access; a model; a tool or MCP server | Met | [config](config/openclaw.generated.json), [01-agents.png](screenshots/01-agents.png), [06-execute-playwright-mcp.png](screenshots/06-execute-playwright-mcp.png) |
| 2 | Persistent memory used after a restart, in a new conversation | Met | [e2e scenario C](tests/e2e-telegram-chats.md#scenario-c-save-info--save-this-gateway-restart-new-the-next-order-uses-the-memory), [04-cos-memory-save-and-use.png](screenshots/04-cos-memory-save-and-use.png) |
| 3 | Channel: the user sets the task and gets the result in Telegram/Slack/WhatsApp/Discord | Met (Telegram) | [live COS session](live-run/cos-session.md), [e2e chats](tests/e2e-telegram-chats.md) |
| 4 | Collaboration through A2A: several agents that interact | Met (see the note) | [02-cos-delegates-to-explore.png](screenshots/02-cos-delegates-to-explore.png), [03-cos-answer-via-sessions-send.png](screenshots/03-cos-answer-via-sessions-send.png), [sessions](live-run/sessions.md) |
| 5 | Observability: a dashboard with agent actions, tool calls, A2A exchange, statuses and errors | Met | [screenshots 01–09](screenshots/), OpenClaw Control UI (`pnpm dashboard`) |
| ✓ | Someone else can deploy it from the README with their own credentials and repeat the scenario | Met | [fresh-copy.log](tests/fresh-copy.log), [e2e.log](tests/e2e.log) (65/65, no keys needed) |

## 1. Agents

Four OpenClaw agents, each with its own workspace, instructions and tool allow-list:

| Agent | Role | Instructions | Model | Tools it may call |
|---|---|---|---|---|
| `cos` | Chief of Staff: the only one that talks to the user, plans, delegates, keeps the memory | [agents/cos/AGENTS.md](../agents/cos/AGENTS.md), [SOUL.md](../agents/cos/SOUL.md) | claude-opus-5-5 | `message` (owner chat only), `sessions_spawn`, `sessions_send`, `sessions_yield`, `subagents`, `read`/`write`/`edit` on `MEMORY.md` only, `memory_search`, `memory_get`, `poo_task`, `poo_answer`, … |
| `explore` | Owns the product list; asks what to buy | [agents/explore/AGENTS.md](../agents/explore/AGENTS.md), skill [ask-what-to-buy](../agents/explore/skills/ask-what-to-buy/SKILL.md) | claude-sonnet-5-5 | `read` (its skill file only), `poo_ask_user`, `poo_update_product_list`, `poo_submit_selection` |
| `execute` | Fills the shop basket in the user's Chrome | [agents/execute/AGENTS.md](../agents/execute/AGENTS.md) | claude-sonnet-5-5 | Playwright MCP `browser_{tabs,navigate,snapshot,wait_for,evaluate,take_screenshot,console_messages}`, `poo_ask_user`, `poo_submit_execute` |
| `qa` | Opens the basket like the user and reports it, read-only | [agents/qa/AGENTS.md](../agents/qa/AGENTS.md) | claude-sonnet-5-5 | the Execute browser tools + `browser_click` (basket icon only), `poo_ask_user`, `poo_submit_qa` |

- **Configuration:** [src/openclaw/config.ts](../src/openclaw/config.ts) generates the gateway config: per-agent
  `model` and `tools.allow` (lines 77–109), Telegram bound to `cos` only (line 114), the Playwright MCP server
  (lines 132–136). The generated result with fictional values: [config/openclaw.generated.json](config/openclaw.generated.json).
- **Access boundaries enforced in code**, not only in prompts: the plugin narrows each turn to the agent's own tools
  (`before_prompt_build` → `toolsAllow`, [src/plugin/hooks.ts:312](../src/plugin/hooks.ts)) and refuses anything else
  (`before_tool_call`, [src/plugin/hooks.ts:61](../src/plugin/hooks.ts)); the lists are in
  [src/plugin/tools.ts:20–42](../src/plugin/tools.ts) and [src/core/browser/toolset.ts](../src/core/browser/toolset.ts).
- **Model connected:** every turn of the real run shows its model in the [sessions table](live-run/sessions.md) and in
  [01-agents.png](screenshots/01-agents.png).
- **Tools and MCP:** 12 plugin tools ([src/plugin/tools.ts](../src/plugin/tools.ts)) and the Playwright MCP server
  (`@playwright/mcp` 0.0.83). Real MCP calls: [execute-session.md](live-run/execute-session.md),
  [qa-session.md](live-run/qa-session.md), [06](screenshots/06-execute-playwright-mcp.png), [07](screenshots/07-qa-playwright-mcp.png).
- **Boundaries tested:** unit tests "tool policy", "Explore reads only its skill", "COS's memory file" in
  [unit-tests.log](tests/unit-tests.log); e2e scenario D refuses and records 9 forbidden calls (COS writing another
  file, Explore reading outside its skill, Execute leaving the shop, free JavaScript, the order form, clicks, QA
  changing the basket, a sub-agent messaging the user, the link before verification): [e2e.log](tests/e2e.log) lines 102–110.
  A real refusal from the live run: Explore's `read` outside its skill, [05-explore-refused-read.png](screenshots/05-explore-refused-read.png).

## 2. Persistent memory

- **What is stored:** COS's `agents/cos/MEMORY.md` (created from a template by [src/core/memory.ts](../src/core/memory.ts),
  git-ignored because it holds the user's preferences). "save this - …" in Telegram makes COS `edit` it; OpenClaw puts the
  file into COS's system prompt on every turn, and the next new order passes its products as `standing`. A second store,
  the plugin's order and task state (`.runtime/openclaw/state/product-order-orchestrator/state.json`), is rewritten
  atomically after every change and survives restarts (unit test "keeps the order and the tasks across a gateway restart").
- **After a restart, in a new conversation (automated):** e2e scenario C saves "add Філе зі стегна індички, 1 кг to every
  future order", **stops the gateway process and starts it again**, sends `/new` (OpenClaw starts a new COS session; the
  test checks that the new conversation no longer contains the "save this" message), then "хочу замовити". The next
  question says «Завжди додається до замовлення: Філе зі стегна індички, 1 кг × 1» and the basket in the browser holds the
  product. See [e2e-telegram-chats.md](tests/e2e-telegram-chats.md) (with the two gateway starts from its log) and
  [e2e.log](tests/e2e.log) lines 35–94. Code: [test/e2e/run.e2e.ts](../test/e2e/run.e2e.ts) (scenario C),
  [test/e2e/lib/gateway.ts](../test/e2e/lib/gateway.ts) (`restart()`).
- **Live run:** at 12:19 UTC the user wrote "save this - add Філе зі стегна індички, 1 кг to every future order"; COS
  edited `MEMORY.md`; the next order at 12:20 started with `poo_task {"standing":[{"name":"Філе зі стегна індички, 1 кг","qty":1}]}`
  and the product was in the basket. [cos-session.md](live-run/cos-session.md), [04-cos-memory-save-and-use.png](screenshots/04-cos-memory-save-and-use.png).

## 3. Communication channel: Telegram

- **Setup:** README "Create the Telegram bot"; `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALLOWED_USER_ID` in `.env`; the
  config binds Telegram to COS with `dmPolicy: "allowlist"` (only the owner) — [config/openclaw.generated.json](config/openclaw.generated.json) `bindings`, `channels.telegram`.
- **Live run:** every user message in [cos-session.md](live-run/cos-session.md) is marked "user via **telegram**", and
  every answer is a `message` tool call delivered to the owner's chat (`chatId: <owner-id>`): the question, the selection,
  the final basket summary with the link. [doctor.txt](config/doctor.txt) shows the bot and "Telegram → cos, owner only".
- **Automated:** the e2e runs the real gateway against a fake Telegram Bot API; each scenario's chat is in
  [e2e-telegram-chats.md](tests/e2e-telegram-chats.md), and "the bot wrote only to the owner" passes in all four.

## 4. Collaboration between agents (A2A)

COS delegates to Explore, Execute and QA and talks to them through OpenClaw's agent-to-agent session tools; the
sub-agents report back to COS, and COS passes results and the user's answers between them:

1. COS creates a task (`poo_task`) and starts the sub-agent with `sessions_spawn {"agentId":"explore","task":"explore-…"}`;
   OpenClaw answers with the child session (`childSessionKey`, `completionTarget: "parent"`) — [02](screenshots/02-cos-delegates-to-explore.png).
2. The sub-agent works in its own session and returns its result to COS as a completion event; a question for the user
   goes back the same way (`poo_ask_user`), and COS relays it word for word.
3. COS sends the user's answer into the **same** child session with `sessions_send` — [03](screenshots/03-cos-answer-via-sessions-send.png);
   the child shows it as a message "From Cos" — [05](screenshots/05-explore-refused-read.png).
4. Explore's selection becomes Execute's task, Execute's result becomes QA's task, QA's verdict decides whether COS may
   send the link ([cos-session.md](live-run/cos-session.md), 6 spawns and 2 `sessions_send` in the live run).

All six sub-agent runs of the live run are children of `agent:cos:main` (`spawnedBy`) — [sessions.md](live-run/sessions.md).

> **Note on the word "A2A".** The agents interact agent-to-agent inside one OpenClaw gateway (session tools, completion
> events), in a hub-and-spoke shape: sub-agents never message each other directly, every hand-off goes through COS. The
> config sets `tools.agentToAgent.enabled: false` on purpose: it blocks *unrelated* sessions from reaching each other,
> while COS keeps access to the children it spawned (`tools.sessions.visibility: "tree"`). The system does not speak the
> separate Agent2Agent JSON-RPC protocol (a2a-protocol.org). If the assignment means that protocol specifically, it is not
> covered.

## 5. Observability: the OpenClaw Control UI

`pnpm dashboard` opens the Control UI (http://127.0.0.1:18789). Screenshots from the real run:

| Screenshot | Shows |
|---|---|
| [01-agents.png](screenshots/01-agents.png) | The four agents and their models |
| [02-cos-delegates-to-explore.png](screenshots/02-cos-delegates-to-explore.png) | COS's tool calls (`poo_task`, `sessions_spawn` with arguments and result, `sessions_yield`, `message`) |
| [03-cos-answer-via-sessions-send.png](screenshots/03-cos-answer-via-sessions-send.png) | The A2A exchange: `poo_answer`, then `sessions_send` into the Explore session, its result state `completed` |
| [04-cos-memory-save-and-use.png](screenshots/04-cos-memory-save-and-use.png) | "save this" → `Edited MEMORY.md +3 −1` |
| [05-explore-refused-read.png](screenshots/05-explore-refused-read.png) | A sub-agent run: task from COS, a **failed** (refused) tool call, the message "From Cos", the submitted result |
| [06-execute-playwright-mcp.png](screenshots/06-execute-playwright-mcp.png) | Execute's Playwright MCP calls and its result |
| [07-qa-playwright-mcp.png](screenshots/07-qa-playwright-mcp.png) | QA's Playwright MCP calls (navigate, click on the cart icon, evaluate, snapshot) and its verdict |
| [08-usage.png](screenshots/08-usage.png) | Tokens, cost, sessions, tool calls (78), errors (2), top models and tools |
| [09-sessions.png](screenshots/09-sessions.png) | Session status (Done) and context usage |

Statuses of every run (`done`) are in [sessions.md](live-run/sessions.md); refused calls appear as failed tool calls with
the reason, in the UI and in the transcripts (e2e scenario D checks that each refusal is recorded).

## Readiness: someone else can deploy and repeat it

- [tests/fresh-copy.log](tests/fresh-copy.log): a copy of the repository with only the files git would publish (no `.env`,
  no `node_modules`), set up by the README steps with **fictional** credentials: `pnpm install` → `pnpm typecheck` →
  `pnpm test` (302 passed) → `pnpm plugin:build` → `pnpm openclaw:config` → `pnpm run doctor`. Doctor passes everything
  except the two checks that need real credentials and a running gateway (the fake Telegram token is rejected; the gateway
  is not started) and prints the fix for each.
- [tests/e2e.log](tests/e2e.log): `pnpm test:e2e` runs the whole scenario (order, fix, memory with restart, forbidden
  calls) in a real OpenClaw gateway with no API keys: 65/65 checks pass. [e2e-report.json](tests/e2e-report.json) is its report.
- With real credentials, the README's steps 1–7 lead to the run shown in [live-run/](live-run/).

## How to regenerate

```bash
pnpm test                                     # unit tests
pnpm test:e2e                                 # end-to-end, about 5 minutes, needs Chrome
pnpm run doctor                               # setup checks
pnpm openclaw gateway call sessions.list --json
pnpm openclaw gateway call chat.history --params '{"sessionKey":"agent:cos:main","limit":500}' --json
pnpm dashboard                                # the Control UI
```
