# Product Order Orchestrator

You tell a Telegram bot what you want to buy. A small team of AI agents fills the shop basket **in your own
Chrome profile** and sends you the basket link. Checkout and payment stay with you: the agents never place an order.

- **COS (Chief of Staff)** is the only agent that talks to you, in your Telegram chat. It plans the work and
  delegates it over the A2A protocol.
- **Explore** owns your product list and asks you which products to buy and how many.
- **Execute** fills the basket in your browser (Playwright MCP through the Playwright MCP Bridge extension).
- **QA** opens the basket, reads it and reports any differences (Playwright MCP too; agent-browser MCP is
  available with the CDP fallback).
- Two dashboards show what the agents do: a built-in live dashboard and **ClawMetry**, the OpenClaw observability
  dashboard, for OpenTelemetry traces.

The first supported shop is [karashynyard.com.ua](https://karashynyard.com.ua/). Diagrams, contracts and the order
flow are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Where things are

| What | Where |
|---|---|
| Your Telegram chat | `https://t.me/<your_bot_username>`. `pnpm run doctor` prints the exact link. |
| Built-in agent dashboard | http://127.0.0.1:41010 (agents, A2A messages, tool calls, errors, Telegram transcript, cost) |
| ClawMetry (OpenClaw observability) | http://127.0.0.1:8900 (trace trees, sessions, tokens, cost) |
| A2A agent cards | http://127.0.0.1:41001/.well-known/agent-card.json (Explore), `:41002` (Execute), `:41003` (QA), while the agent runs |
| Logs | The `pnpm start` terminal (`[hub]`, `[cos]` lines); sub-agents: `.runtime/logs/<agent>.log`; ClawMetry daemon: `.runtime/logs/clawmetry-sync.log` |
| Dashboard event journal | `.runtime/events/YYYY-MM-DD.jsonl` (one JSON event per line; days older than `RUNTIME_RETENTION_DAYS`, default 14, are deleted on start) |
| Browser snapshots and screenshots | `.runtime/runs/<taskId>/` (same retention) |
| Your product list | `agents/explore/.claude/skills/ask-what-to-buy/SKILL.md` (change it from Telegram with "save info") |
| Configuration | `.env` (documented in [.env.example](.env.example)) |

## Prerequisites

- **macOS** with **Google Chrome** as your default browser.
- **Node.js 24** through nvm: `nvm install && nvm use` in the project folder (`.nvmrc` pins 24.21.0; 24.16 or newer
  is required).
- **pnpm** through corepack, which ships with Node: `corepack enable` once, or prefix commands with `corepack`.
- **Python 3.8+** for ClawMetry. The macOS system `python3` (3.9) works.
- The **Telegram** app, and an **Anthropic API key** (https://console.anthropic.com/settings/keys).

## Setup, step by step (once)

1. **Install.**

   ```bash
   git clone https://github.com/ElikaFilin/product-order-orchestrator.git
   cd product-order-orchestrator
   nvm install && nvm use
   corepack enable
   pnpm install
   cp .env.example .env   # skip if .env already exists
   ```

2. **Create your Telegram bot.** In Telegram, open **@BotFather** and send `/newbot`. Give it a display name, then
   a username that ends in `bot` (for example `my_basket_bot`). BotFather replies with a token like
   `110201543:AAH...`. Put it into `.env` as `TELEGRAM_BOT_TOKEN=...`. Never share or commit the token; `/token` in
   BotFather issues a new one if it leaks.

3. **Add your Anthropic API key** to `.env` as `ANTHROPIC_API_KEY=...`.

4. **Get your numeric Telegram id.** With `TELEGRAM_ALLOWED_USER_ID` still empty, the bot runs in setup mode:
   - run `pnpm start`,
   - open your bot (`https://t.me/<your_bot_username>`), press **Start** or send `/start`,
   - the bot replies with your id and the exact line to add: `TELEGRAM_ALLOWED_USER_ID=123456789`,
   - put that line into `.env`, stop with `Ctrl+C`.

   From now on the bot answers only you and ignores everyone else.

5. **Connect your Chrome profile.** The shop keeps the basket only in the browser's storage, so Execute and QA
   work in your own Chrome profile. They connect through the **Playwright MCP Bridge** extension; Chrome needs no
   debugging port.
   - In Chrome, switch to the profile you shop in and install the extension from the
     [Chrome Web Store](https://chromewebstore.google.com/detail/mmlmfjhmonkocbjadbfplnigmagldckm).
   - The agents use the `Default` profile (the first one Chrome created). For another profile, set
     `CHROME_PROFILE_DIR` in `.env` to its folder name: open `chrome://version` in that profile, the
     **Profile Path** ends with it (for example `Profile 4`).
   - Click the extension's icon and copy the token it shows into `.env` as `PLAYWRIGHT_MCP_EXTENSION_TOKEN=...`.
     Without it, Chrome asks you to approve the connection on every Execute and QA run. Treat it like a password:
     a program on your Mac that has the token can drive this Chrome profile without asking.
   - Chrome does not have to be open: an agent run opens it.

   *Fallback (`BROWSER_MODE=cdp`):* `pnpm browser:chrome` starts Google Chrome with a separate profile for this
   project (`~/.product-order-orchestrator/chrome-profile`) and remote debugging on port 9333
   (`CHROME_DEBUG_PORT=<port> pnpm browser:chrome` moves it; then set the same port in `BROWSER_CDP_URL`). Set
   `BROWSER_MODE=cdp` in `.env`. The basket then lives in that Chrome window, so open the final basket link there.
   In this mode `QA_BROWSER_MCP=agent-browser` works too. **Security note:** while that Chrome runs, any program on
   your Mac under your user account can control it through the port (127.0.0.1 only).

6. **Install ClawMetry** (optional but recommended; the built-in dashboard works without it):

   ```bash
   pnpm clawmetry:setup    # once: Python virtualenv in .runtime/clawmetry-venv, clawmetry 0.12.915
   pnpm clawmetry          # every time, in its own terminal; Ctrl+C stops it
   ```

7. **Check everything:**

   ```bash
   pnpm run doctor
   ```

   Every required line must show `✓`. Each `✗` comes with a `fix:` hint. `!` lines are optional (default browser,
   extension token, dashboard, ClawMetry). Keep the `run`: a bare `pnpm doctor` is pnpm's own command and checks nothing here.

8. **Start the system:**

   ```bash
   pnpm start              # dashboard hub + COS; COS starts each sub-agent the first time it needs it
   pnpm start:all          # same, but COS starts all sub-agents right away (faster first order)
   ```

   The terminal prints the dashboard, ClawMetry and agent-card links. `Ctrl+C` stops everything.

## Using it from Telegram

Open the chat with your bot and write in Ukrainian or English. A typical order:

```text
You:  хочу замовити
Bot:  Що замовити? Напишіть номер товару і кількість, кожен товар з нового рядка,
      у форматі «номер - кількість». Без кількості = 1 шт.
      1. Філе зі стегна індички, 1 кг — ≈665 грн
      2. Стегно індички, 1 кг — ≈595 грн
      ...
You:  1 - 2
      5
Bot:  (confirms the selection: name × quantity)
      ... Execute fills the basket in Chrome, QA checks it ...
Bot:  (what is in the basket, the total) and the link
      https://karashynyard.com.ua/#opencart
```

- **Answer format:** one product per line, `номер - кількість` (`1 - 2`, `1-2`, `1 x 2` also work). A number
  alone means one item (`5`). If a line is unclear, Explore asks about that line once.
- **Adding later:** "і ще 5" or "also 3 - 2" after the selection adds those products to the current order
  (quantities of a product already in it add up). To change or remove a product, just say so.
- **Writing while the agents work:** the bot says it got the message and reads it when the current step
  finishes. A message written before a question was asked is not taken as the answer to it.
- **Differences:** if QA finds a difference (a product missing, an extra one, a wrong quantity), the bot lists it
  (`name: expected X, in the basket Y`) and asks what to do. Answer "fix it" / "виправ" to let Execute correct
  the basket (QA checks again), or say which lines to keep as they are.
- **Final link:** open it in Chrome, in the profile the bot names: the basket lives only there. If you used
  another Chrome profile last, the link may open in that one. (With the CDP fallback: in that Chrome window.) The link comes only after QA has read the basket window the way you see it. Check it, then fill
  in delivery and pay on the shop page yourself.
- **Product list:** `save info - add "Печінка індички, 500 г" to product list selection` adds a product,
  `save info - remove "<product>" from product list` removes one. The next order question includes the change.
- **Commands:** `/status` (order state and running tasks), `/stop` (cancel all running work, the order is kept),
  `/new` (start a new order), `/dashboard` (monitoring links), `/help`.

## The dashboards

### Built-in dashboard (http://127.0.0.1:41010)

Started by `pnpm start` (or alone with `pnpm dashboard`). Every agent process sends its events there; the page
updates live over a WebSocket and reconnects by itself.

- **Agents:** one card per agent with its state (idle, busy, waiting for input, error, stopped, offline), what it
  is doing, tool calls, errors, tokens and estimated cost (both from each run's final usage report). An agent that
  is not running when the dashboard starts is shown as stopped.
- **A2A communication:** every message between COS and a sub-agent (`cos → explore`), with task state
  (`input-required`, `completed`, `failed`) and the full payload on demand.
- **Telegram chat:** the conversation as the bot saw it.
- **Tool calls:** time, agent, tool, input, result (ok, error, denied by the safety guard) and duration.
- **Errors**, **A2A tasks** and the raw **event log**.
- **Filters:** by agent and by order (A2A context); the event log also filters by event kind.

The hub keeps the latest 20,000 events in memory and appends every event to `.runtime/events/YYYY-MM-DD.jsonl`
(today's file is reloaded on restart). JSON API: `GET /api/events?agent=&kind=&taskId=&contextId=&since=&limit=`,
`GET /api/agents`, `GET /api/tasks`, `GET /api/health`; WebSocket `/ws`. It listens on 127.0.0.1 only (or
`localhost`; other hosts are refused because it has no authentication). Other tabs of your browser never reach the
dashboard: browser tool results show them as `[another tab, hidden]`.

### ClawMetry (http://127.0.0.1:8900)

[ClawMetry](https://github.com/vivekchand/clawmetry), the OpenClaw observability dashboard, receives our
OpenTelemetry spans at `http://127.0.0.1:8900/v1/traces`. Each agent reports as its own service: `poo-cos`,
`poo-explore`, `poo-execute`, `poo-qa`. Spans follow the GenAI conventions: `invoke_agent <agent>` per A2A task,
`execute_tool <tool>` per tool call (failed calls are marked as errors), `chat <model>` per model turn with that
turn's token usage. A delegation keeps one trace across agents.

How to look at it:

1. In the top bar, set **Runtime** to **All runtimes** (the default, OpenClaw, hides our traces).
2. Open **Developer → Tracing** and click a trace: the span tree shows `invoke_agent <agent>`, its tool calls (red
   when they failed) and model calls with tokens and cost. **Waterfall** and **Agent graph** are on the same page.
3. **Sessions** and **Cost** summarize tokens and spend.

No account is needed: ignore **Enable Cloud Sync** and the sign-in button (signing in would upload data and install
a background service). `pnpm clawmetry` runs it with privacy defaults: its own home in `.runtime/clawmetry-home` (it
does not read your personal agent folders such as `~/.claude`), no first-run sign-in gate, no install ping, no update
checks or self-updates, no cloud sync, no LLM calls, nothing left running after `Ctrl+C`, bound to 127.0.0.1. Its
free tier keeps 7 days of data. ClawMetry prices tokens with its own price table, so its cost can differ from the
Agent SDK estimate on the built-in dashboard.

## Adding another shop

1. Implement `ShopAdapter` (`src/shops/types.ts`) in `src/shops/<id>/index.ts`: base and basket URLs, allowed
   origins, checkout endpoints to block, forbidden patterns (checkout form, submit buttons), the in-page helper
   and the Execute/QA playbooks. Use `src/shops/karashynyard/` as the template.
2. Register it in the `SHOPS` map in `src/shops/index.ts`.
3. Add a product table for it to `agents/explore/.claude/skills/ask-what-to-buy/SKILL.md`, under
   `## Product lists`, between `<!-- products:<id>:start -->` and `<!-- products:<id>:end -->` (same columns as
   the karashynyard table).
4. Set `DEFAULT_SHOP=<id>` in `.env`, then run `pnpm smoke:shop <id>` (it uses a throwaway headless Chrome) and
   `pnpm test`.

## Troubleshooting

- **"Browser not connected" / `pnpm run doctor` shows ✗ Browser:** the Playwright MCP Bridge extension is not
  installed in the profile `CHROME_PROFILE_DIR` names (default `Default`). Install it there or fix the setting
  (step 5), then tell the bot to retry. With `BROWSER_MODE=cdp`: run `pnpm browser:chrome`.
- **Chrome shows a connection approval page on every run:** set `PLAYWRIGHT_MCP_EXTENSION_TOKEN` (step 5). If the
  extension issued a new token, copy it again.
- **The basket link shows an empty basket:** it opened in another Chrome profile. Open it in the profile the bot
  named.
- **Telegram `409 Conflict`:** another process is polling with the same bot token (a second `pnpm start`, or
  the same token used elsewhere). Stop the other one; one token, one running bot.
- **The bot does not answer:** check `TELEGRAM_ALLOWED_USER_ID` (setup mode replies only to `/start`), and look
  at the `[cos]` lines in the terminal.
- **`ANTHROPIC_API_KEY is not set` / `LLM_ERROR`:** put a valid key into `.env` and restart. The **Errors** panel
  of the dashboard shows the exact message.
- **Costs and budgets:** each sub-agent task stops at its budget (`EXPLORE_MAX_BUDGET_USD`,
  `EXECUTE_MAX_BUDGET_USD`, `QA_MAX_BUDGET_USD`; defaults 0.5, 3 and 1.5 USD) and reports `BUDGET_EXCEEDED` to COS.
  `COS_MAX_BUDGET_USD` (default 2) limits one COS model session, not the total: past 60% of it COS starts a fresh
  session between messages, and a session that reaches it in the middle of a step is replaced and continues that
  step. Order facts carry over in both cases. The agent cards show the running estimate. Cheaper models can be set
  with `COS_MODEL` and friends.
- **A port is in use:** `pnpm run doctor` names it (agent ports and the dashboard port). Stop the other program or
  change `EXPLORE_PORT`, `EXECUTE_PORT`, `QA_PORT`, `DASHBOARD_PORT` in `.env`.
- **ClawMetry shows nothing:** is `pnpm clawmetry` running? Spans sent while it was down are lost. Check
  `http://127.0.0.1:8900/api/otel-status` and `OTEL_EXPORTER_OTLP_ENDPOINT` (empty disables tracing). If its store
  fails to open after a fresh setup, see `.runtime/logs/clawmetry-sync.log` and compare
  `.runtime/clawmetry-venv/bin/python -m pip freeze` with `scripts/clawmetry-constraints.txt` (the verified versions).
- **The dashboard is empty:** is `DASHBOARD_ENABLED` unset or `1`, and does `pnpm run doctor` show the hub?

## Safety

- **Never checks out.** The order form and its "Відправити замовлення" button are never touched. The agents have
  no tool that types, presses keys or fills forms; a page script may only be one call of the shop's helper (no
  free JavaScript), and only Execute's helper calls change the basket; QA can click nothing but the basket icon. A
  guard also denies any tool call that mentions the order form, a submit action or the order endpoints,
  Playwright blocks those endpoints, navigation is limited to the shop, and risky browser tools are not available.
  The agents never ask for delivery, contact or payment details.
- **Your other tabs.** Execute and QA work only in a tab opened for their run (through the extension they cannot
  even see your other tabs), tabs are never listed, selected or closed, and every page script first checks that it
  runs on the shop. Through the extension each run closes its tab when it is done (a run cut off midway may leave its tab open). Titles
  and URLs of your other tabs are hidden from the models, the dashboard and the logs.
- **Only you.** The bot serves only `TELEGRAM_ALLOWED_USER_ID`. The bot token stays in COS's own process: the
  sub-agents, the agents' Claude Code processes and the browser tool servers never get it (nor the API key, for
  the browser tool servers).
- **Locked-down agents.** Each agent may call only its own allow-listed tools; built-in file, shell and web tools
  are disabled in code, not just in prompts.
- **Browser exposure.** The extension opens no port. Its token lets a local program that has it drive your Chrome
  profile without asking, so it stays in `.env`, and only the Playwright tool server gets it. The CDP fallback
  opens a debugging port for local programs (see step 5): close that Chrome when you do not need the agents.
- **Local only.** The dashboard, the agents and ClawMetry listen on 127.0.0.1, and the dashboard and the agents
  refuse requests addressed to any other host name. Secrets live in `.env`, which git ignores. Old runtime files
  (journal days, browser snapshots) are deleted after `RUNTIME_RETENTION_DAYS`, and the agents keep no transcripts.

## Development

```bash
pnpm typecheck            # tsc
pnpm test                 # vitest
pnpm smoke:shop           # live check of the shop adapter in a throwaway headless Chrome
pnpm test:e2e             # full end-to-end run, see below (about 1 minute)
pnpm dashboard            # the dashboard hub alone
pnpm agent:explore        # one sub-agent alone (also agent:execute, agent:qa, agent:cos)
```

Layout: `src/agents/<agent>/` (agent processes), `agents/<agent>/` (their instructions and, for Explore, the
skill), `src/shared/` (A2A, Agent SDK wiring, contracts), `src/browser/`, `src/shops/`, `src/observability/`
(telemetry, dashboard hub), `src/launcher.ts`, `src/cli/doctor.ts`, `scripts/`.

### End-to-end test

`pnpm test:e2e` (`test/e2e/run.e2e.ts`, not part of `pnpm test`) starts the real system with `src/launcher.ts`.
That covers the hub, COS and the sub-agents that COS spawns, the Claude Code CLI under every agent, A2A, Playwright MCP
and agent-browser MCP. It fakes only the Anthropic API (a local scripted model that reads its tool results) and the
Telegram Bot API. Each scenario gets a throwaway headless Chrome with a fresh profile, driving the live shop. The
basket lives only in that profile, the order form is never touched, and no key or bot token is needed. The scenarios:

- A: order, question, selection, fill, QA match, link.
- B: an extra line seeded in the basket, a QA mismatch, the user's "прибери зайве", a fix, a focused re-check, the link.
- C: `save info - add ...`, the skill updated, the next question lists the product.

The run uses a temporary copy of the repo, so the real `SKILL.md` never changes. It needs Node 24, Google Chrome
and internet access. `-- --only A,C` runs a subset. `E2E_WORK_DIR` sets where the logs and `report.json` go,
`E2E_KEEP=1` keeps the repo copy, and `CHROME_PATH` and `E2E_PORT_FROM`/`E2E_PORT_TO` (default 9400-9599) adjust the
browser and ports.
