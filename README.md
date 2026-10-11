# Product Order Orchestrator

You tell a Telegram bot what you want to buy. A small team of AI agents fills the shop basket **in your own Chrome
profile** and sends you the basket link. Checkout and payment stay with you: the agents never place an order.

The agents run inside one [OpenClaw](https://github.com/openclaw/openclaw) gateway (2026.9.9, pinned in this repo), so
its Control UI shows every agent's sessions, tool calls, sub-agent runs, statuses and errors:

- **COS (Chief of Staff)** is the only agent that talks to you, in your Telegram chat. It plans the work and starts
  the other agents as OpenClaw sub-agents.
- **Explore** owns your product list (an OpenClaw skill) and asks you which products to buy and how many.
- **Execute** fills the basket in your browser through Playwright MCP and the Playwright Extension.
- **QA** opens the basket the way you do, reads it and reports any differences.

Every rule is enforced in code by this repo's OpenClaw plugin (`src/plugin/`): which tools each agent may call, the
shop safety guards, verbatim questions and answers, and that the basket link goes out only after QA verified the
basket. The first supported shop is [karashynyard.com.ua](https://karashynyard.com.ua/). Diagrams and the order flow
are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Everything is project-level: OpenClaw runs from `node_modules`, its state lives in `.runtime/openclaw/`, and the
secrets live only in this repo's `.env`. Nothing is installed globally and `~/.openclaw` is not used.

## Where things are

| What | Where |
|---|---|
| Your Telegram chat | `https://t.me/<your_bot_username>`. `pnpm run doctor` prints the exact link. |
| OpenClaw Control UI | http://127.0.0.1:18789. `pnpm dashboard` opens it signed in. |
| Sub-agent runs | In COS's chat in the Control UI: `/subagents list`, `/subagents info <#>`, `/subagents log <#>`. |
| Gateway logs | The `pnpm start` terminal, `pnpm openclaw logs --follow`, files in `/tmp/openclaw/`. |
| Secrets and settings | `.env` (documented in [.env.example](.env.example)). |
| OpenClaw config | `.runtime/openclaw/openclaw.json`, generated from `.env` on every `pnpm start` (edit `src/openclaw/config.ts`, not the file). |
| OpenClaw state | `.runtime/openclaw/state/` (sessions, transcripts); the order and tasks: `.runtime/openclaw/state/product-order-orchestrator/state.json`. |
| Agent instructions | `agents/<agent>/AGENTS.md` (the OpenClaw workspaces are these folders). |
| Your product list | `agents/explore/skills/ask-what-to-buy/SKILL.md` (change it from Telegram with "save info"). |
| Browser snapshots | `.runtime/playwright/`. |

## Run it on a new computer

### 1. What you need

- **macOS** with **Google Chrome**, set as the default browser (the basket link opens there).
- **nvm** (https://github.com/nvm-sh/nvm). Node.js 24 and pnpm come through it below.
- **git**.
- The **Telegram** app.
- An **Anthropic API key** with credits: https://console.anthropic.com/settings/keys.

### 2. Get the code and install

```bash
git clone https://github.com/ElikaFilin/product-order-orchestrator.git
cd product-order-orchestrator
nvm install                 # Node 24.21.0 from .nvmrc
nvm alias default 24        # optional: new terminals start with Node 24
corepack enable             # makes `pnpm` available (it ships with Node)
pnpm install                # also installs the pinned OpenClaw
```

### 3. Create the Telegram bot

1. In Telegram, open **@BotFather**, send `/newbot`, choose a name and a username ending in `bot`. Copy the token.
2. Send any message to **@userinfobot** and copy your numeric id.

### 4. Connect Chrome

1. In Chrome, switch to the profile your basket should live in.
2. Install the **Playwright Extension** (0.4.0 or newer):
   https://chromewebstore.google.com/detail/mmlmfjhmonkocbjadbfplnigmagldckm
3. Click the extension's icon and copy its **token**. Treat it like a password: a program that has it can drive this
   Chrome profile.
4. If that profile is not your first one, find its folder name: open `chrome://version`; **Profile Path** ends with
   it (for example `Profile 4`).

### 5. Fill in `.env`

```bash
cp .env.example .env
```

Fill in:

| Key | Value |
|---|---|
| `ANTHROPIC_API_KEY` | your Anthropic API key |
| `TELEGRAM_BOT_TOKEN` | the token from @BotFather |
| `TELEGRAM_ALLOWED_USER_ID` | your numeric Telegram id (COS answers only you) |
| `PLAYWRIGHT_MCP_EXTENSION_TOKEN` | the extension's token |
| `CHROME_PROFILE_DIR` | only if the profile folder is not `Default` |

`.env` is ignored by git. It is the only place for secrets: every `pnpm` script loads it, and the gateway gets the
values from there.

### 6. Start

```bash
pnpm start
```

It builds the plugin, writes `.runtime/openclaw/openclaw.json` from `.env`, and runs the OpenClaw gateway in this
terminal (`Ctrl+C` stops it). Keep the terminal open while you use the bot. Only one program may poll a bot token: stop
anything else that uses the same bot first.

In a second terminal (in the project folder):

```bash
pnpm dashboard              # opens the Control UI in your browser, signed in
pnpm run doctor             # every line must show ✓; each ✗ comes with a fix
```

Keep the `run` in `pnpm run doctor`: a bare `pnpm doctor` is pnpm's own command.

### 7. Order

Keep Chrome running with the extension's profile. Open your bot in Telegram and write `хочу замовити`. Each Execute and
QA run opens and focuses its own "Playwright · …" tab group in Chrome.

### Other OpenClaw commands

`pnpm openclaw <command>` is the project's OpenClaw CLI (the same commands as `openclaw`, pointed at this project):
`pnpm openclaw gateway status`, `pnpm openclaw logs --follow`, `pnpm openclaw sessions`, `pnpm openclaw dashboard`.
There is no global `openclaw` command, and none is needed.

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
Bot:  (what is in the basket) and the link
      https://karashynyard.com.ua/#opencart
```

- **Answer format:** one product per line, `номер - кількість` (`1 - 2`, `1-2`, `1 x 2` also work). A number alone
  means one item (`5`). If a line is unclear, Explore asks about that line once.
- **Adding later:** "і ще 5" or "also 3 - 2" after the selection adds those products to the current order
  (quantities of a product already in it add up). To change or remove a product, just say so.
- **Writing while the agents work:** your messages queue and COS reads them when the current step finishes. A message
  written before a question was asked is not taken as the answer to it.
- **Differences:** if QA finds a difference (a product missing, an extra one, a wrong quantity), the bot lists it
  and asks what to do. Answer "fix it" / "виправ" / "прибери зайве" to let Execute correct the basket (QA checks
  again, knowing exactly what changed), or say which lines to keep as they are.
- **Final link:** open it in Chrome, in the profile the bot names: the basket lives only there. The link comes only
  after QA has read the basket window the way you see it. Check it, then fill in delivery and pay yourself.
- **Product list:** `save info - add "Печінка індички, 500 г" to product list selection` adds a product,
  `save info - remove "<product>" from product list` removes one. The next order question includes the change.
- **Commands (OpenClaw):** `/new` starts a new order (the plugin clears the order), `/stop` stops the running
  agents, `/status` shows the session, `/subagents list` lists the sub-agent runs.

## Watching the agents

The Control UI (`pnpm dashboard`) is the dashboard:

- **COS's chat** shows every turn and every tool call card (arguments and result): tasks created, sub-agents
  spawned, questions relayed, answers delivered, refused calls with the reason.
- **Sub-agent runs** have no sidebar row. In COS's chat, `/subagents list|info|log` shows them, and each run opens
  view-only (its tool calls, the browser tools and the plugin's refusals included).
- **Agents**, **Activity** (sessions per day), **Usage** (tokens, cost) and **Logs** are in the sidebar.

## Adding another shop

1. Implement `ShopAdapter` (`src/core/shops/types.ts`) in `src/core/shops/<id>/index.ts`: base and basket URLs,
   allowed origins, checkout endpoints to block, forbidden patterns (checkout form, submit buttons), the in-page
   helper and the Execute/QA playbooks. Use `src/core/shops/karashynyard/` as the template.
2. Register it in the `SHOPS` map in `src/core/shops/index.ts`.
3. Add a `### <id>` product table to the skill (`agents/explore/skills/ask-what-to-buy/SKILL.md`).
4. Check the adapter with `pnpm smoke:shop <id>`, then restart `pnpm start`.

## Troubleshooting

- **`pnpm run doctor`** names what is missing and how to fix it.
- **`zsh: command not found: openclaw`:** use `pnpm openclaw <command>` in the project folder.
- **`node` or `pnpm` errors about the version:** run `nvm use` in the project folder (or `nvm alias default 24`).
- **The bot does not answer:** is `pnpm start` running? Does its terminal (or `pnpm openclaw logs --follow`) show
  `409` from Telegram? Then another program polls the same bot token. "Credit balance is too low" means the Anthropic
  account needs credits.
- **The browser does not move:** is Chrome running with the Playwright Extension in the configured profile, and is
  `PLAYWRIGHT_MCP_EXTENSION_TOKEN` set? Without the token, approve the connection in Chrome.
- **A task failed:** COS tells you and offers a retry. In COS's chat, `/subagents log <#>` shows what the sub-agent
  did; the plugin's refusals appear as failed tool calls with the reason.
- **Costs:** the Control UI's Usage page shows tokens and cost per agent. Every sub-agent run has a time limit
  (Explore 5, Execute 15, QA 10 minutes).
- **Start over:** stop `pnpm start` and delete `.runtime/openclaw/state/` (sessions, transcripts and the current order).

## Safety

- **Never checks out.** The order form and its "Відправити замовлення" button are never touched. No agent has a tool
  that types, presses keys or fills forms; a page script may only be one call of the shop's helper (no free
  JavaScript), and only Execute's helper calls change the basket; QA can click nothing but the basket icon. The
  plugin also refuses any tool call that mentions the order form, a submit action or the order endpoints, Playwright
  blocks those endpoints, and navigation is limited to the shop. The agents never ask for delivery, contact or
  payment details.
- **Your other tabs.** Execute and QA work only in a tab opened for their run (through the extension they see only
  their own tab group), tabs are never listed, selected or closed, and every page script first checks that it runs on
  the shop. Titles and URLs of your other tabs are hidden from the models and the transcripts.
- **Only you.** Telegram is bound to COS alone and accepts only `TELEGRAM_ALLOWED_USER_ID`. COS may message only your
  chat; sub-agents have no messaging tool at all.
- **Locked-down agents.** Each agent has an explicit tool allow-list (no shell, files, web or built-in browser), and
  the plugin refuses anything else in code. Explore may read only its skill file.
- **Secrets** live only in `.env`, which git ignores; the generated config holds `${VAR}` references, and the
  extension token goes only to the Playwright MCP server.
- **Local only.** The gateway binds to 127.0.0.1 with a token (`.runtime/openclaw/gateway-token`, created on first
  start); `pnpm dashboard` signs the browser in.

## Development

```bash
pnpm typecheck            # tsc
pnpm test                 # vitest: domain code, plugin (with a fake OpenClaw host), config, doctor
pnpm plugin:build         # bundle src/plugin into openclaw/plugin/dist/index.js
pnpm openclaw:config      # write .runtime/openclaw/openclaw.json (--print: to stdout)
pnpm smoke:shop           # live check of the shop adapter and guards in a throwaway headless Chrome
pnpm test:e2e             # the whole system in an isolated gateway (about 6 minutes), see below
```

Layout: `src/core/` (domain: contracts, order state, product list, selection, Execute/QA results, browser guards,
shops), `src/plugin/` (the OpenClaw plugin: tools, hooks, task store), `src/openclaw/` (config generator and the
project-level OpenClaw paths), `src/browser/` (Chrome detection, Playwright MCP launch arguments), `src/cli/` (doctor,
config, `pnpm openclaw`, smoke test), `agents/<id>/` (the OpenClaw workspaces), `openclaw/plugin/` (manifest and
bundle), `scripts/`.

### End-to-end test

`pnpm test:e2e` (`test/e2e/run.e2e.ts`, not part of `pnpm test`) runs a real foreground OpenClaw gateway from the
repo's pinned `openclaw`, in a temporary state dir, with our generated config and plugin bundle, the four agents and
Playwright MCP over CDP. It fakes only the Anthropic API (a scripted model that reads its tool results) and the
Telegram Bot API, so it needs no keys and spends nothing. Each scenario gets a throwaway headless Chrome with a fresh
profile, driving the live shop; the basket lives only in that profile and the order form is never touched. Scenarios:

- A: order, question, selection, fill, QA match, link.
- B: an extra line in the basket, a QA mismatch, "прибери зайве", a fix, a focused re-check, the link.
- C: `save info - add ...`, the skill updated, the next question lists the product.
- D: forbidden calls (the link before verification, a file outside the skill, another site, free JavaScript, the
  order form, a click from Execute, a basket write from QA, a sub-agent messaging the user) are refused and recorded
  in the session transcripts.

The workspaces are copied, so the real `SKILL.md` never changes. `-- --only A,C` runs a subset; `E2E_WORK_DIR` keeps
the logs, transcripts and `report.json`; `CHROME_PATH` and `E2E_PORT_FROM`/`E2E_PORT_TO` adjust the browser and ports.
