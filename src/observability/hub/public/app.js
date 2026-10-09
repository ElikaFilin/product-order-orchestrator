// Dashboard client: initial load over REST, live updates over WebSocket (auto-reconnect).
// Every string from events is inserted as text (textContent / text nodes), never as HTML.

const KNOWN_AGENTS = ['cos', 'explore', 'execute', 'qa'];
const AGENT_TITLES = { cos: 'COS · Chief of Staff', explore: 'Explore', execute: 'Execute', qa: 'QA' };
const KINDS = ['status', 'a2a', 'tool_call', 'tool_result', 'llm', 'run', 'telegram', 'error', 'log'];
const MAX_EVENTS = 5000;
const INITIAL_EVENTS = 3000;
const LIST_LIMIT = 250;
const AGENT_REFRESH_MS = 30_000;

const state = {
  events: [],
  ids: new Set(),
  agents: [],
  tasks: [],
  lastTs: undefined,
  filters: { agent: '', context: '', kind: '' },
  /** Keys of <details> elements the user opened, so re-rendering keeps them open. */
  open: new Set(),
};

const $ = (id) => document.getElementById(id);

// ---------- DOM helpers ----------

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

/** A <details> whose open state survives re-renders. */
function disclosure(key, summary, ...content) {
  const el = h('details', { open: state.open.has(key), 'data-key': key }, h('summary', null, summary), ...content);
  el.addEventListener('toggle', () => (el.open ? state.open.add(key) : state.open.delete(key)));
  return el;
}

function chip(label, tone) {
  return h('span', { class: 'chip', 'data-tone': tone ?? label }, label);
}

function json(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function safeHref(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : undefined;
}

// ---------- formatting ----------

const fmtTime = (ts) => {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour12: false });
};
const timeEl = (ts) => h('time', { datetime: ts, title: ts }, fmtTime(ts));
const short = (id) => (id ? String(id).slice(0, 8) : '');
const fmtCost = (usd) => `$${(usd ?? 0).toFixed(usd >= 1 ? 2 : 3)}`;
const fmtCount = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n ?? 0));
const fmtDuration = (ms) => (typeof ms !== 'number' ? '' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
const clip = (text, max = 300) => {
  const s = typeof text === 'string' ? text : text === undefined ? '' : json(text);
  return s.length > max ? `${s.slice(0, max)}…` : s;
};
/** "mcp__playwright__browser_click" -> "playwright › browser_click". */
const toolLabel = (name) => {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name ?? '');
  return m ? `${m[1]} › ${m[2]}` : (name ?? 'unknown');
};
const agentTitle = (agent) => AGENT_TITLES[agent] ?? agent;

// ---------- data ----------

async function getJson(path) {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

function addEvents(events) {
  let added = false;
  for (const e of events) {
    if (state.ids.has(e.id)) continue;
    state.ids.add(e.id);
    state.events.push(e);
    if (!state.lastTs || e.ts > state.lastTs) state.lastTs = e.ts;
    added = true;
  }
  if (state.events.length > MAX_EVENTS) {
    for (const e of state.events.splice(0, state.events.length - MAX_EVENTS)) state.ids.delete(e.id);
  }
  if (added) scheduleRender();
}

async function refreshDerived() {
  try {
    const [{ agents }, { tasks }] = await Promise.all([getJson('/api/agents'), getJson('/api/tasks')]);
    state.agents = agents;
    state.tasks = tasks;
    scheduleRender();
  } catch (err) {
    console.warn('refresh failed', err);
  }
}

// Throttled, not debounced: a busy agent emits events continuously and must not starve the refresh.
let refreshTimer;
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    refreshDerived();
  }, 300);
}

// ---------- live connection ----------

function setConnection(kind, text) {
  const el = $('connection');
  el.dataset.state = kind;
  el.textContent = text;
}

let retryMs = 1000;
function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.addEventListener('open', async () => {
    retryMs = 1000;
    setConnection('live', 'Live');
    // Catch up on anything sent while disconnected. Agents flush in batches, so arrival order is not
    // timestamp order: look back a minute and let the id check drop duplicates.
    if (state.lastTs) {
      const since = new Date(Date.parse(state.lastTs) - 60_000).toISOString();
      try {
        const { events } = await getJson(`/api/events?limit=5000&since=${encodeURIComponent(since)}`);
        addEvents(events);
      } catch (err) {
        console.warn('catch-up failed', err);
      }
    }
    scheduleRefresh();
  });
  ws.addEventListener('message', (msg) => {
    try {
      const frame = JSON.parse(msg.data);
      if (frame.type === 'events' && Array.isArray(frame.events)) {
        addEvents(frame.events);
        scheduleRefresh();
      }
    } catch (err) {
      console.warn('bad frame', err);
    }
  });
  ws.addEventListener('close', () => {
    setConnection('down', `Disconnected from the hub, retrying in ${Math.round(retryMs / 1000)} s…`);
    setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 15_000);
  });
}

// ---------- filters ----------

function matches(e, ignoreContext = false) {
  const { agent, context } = state.filters;
  return (
    (!agent || e.agent === agent || a2aRoute(e).includes(agent)) &&
    (ignoreContext || !context || e.contextId === context)
  );
}

function syncSelect(select, options, current) {
  const values = new Set(options.map(([value]) => value));
  if (current && !values.has(current)) options.push([current, current]);
  // Rebuilding an open <select> would close it under the user's pointer: only touch it when something changed.
  const signature = JSON.stringify([options, current]);
  if (select.dataset.signature === signature) return;
  select.dataset.signature = signature;
  select.replaceChildren(...options.map(([value, label]) => h('option', { value, selected: value === current }, label)));
}

function renderFilterOptions() {
  const agents = new Set([...KNOWN_AGENTS, ...state.agents.map((a) => a.agent)]);
  syncSelect(
    $('filter-agent'),
    [['', 'All agents'], ...[...agents].map((a) => [a, agentTitle(a)])],
    state.filters.agent,
  );

  const contexts = new Map();
  for (const t of state.tasks) {
    if (!t.contextId) continue;
    const prev = contexts.get(t.contextId);
    if (!prev || t.firstTs < prev) contexts.set(t.contextId, t.firstTs);
  }
  const sorted = [...contexts.entries()].sort((a, b) => (a[1] < b[1] ? 1 : -1));
  syncSelect(
    $('filter-context'),
    [['', 'All orders'], ...sorted.map(([id, ts]) => [id, `${short(id)} · started ${fmtTime(ts)}`])],
    state.filters.context,
  );
  syncSelect($('filter-kind'), [['', 'All kinds'], ...KINDS.map((k) => [k, k])], state.filters.kind);
}

// ---------- panels ----------

function activityText(a) {
  if (!a.activity) return a.state === 'offline' ? 'No events yet' : '—';
  return a.activity.replace(/^tool: (.+)$/, (_, name) => `tool: ${toolLabel(name)}`);
}

function renderAgents() {
  const cards = state.agents
    .filter((a) => !state.filters.agent || a.agent === state.filters.agent)
    .map((a) => {
      const label = a.state.replace('_', ' ');
      return h(
        'article',
        { class: 'agent-card', 'data-tone': a.state, 'aria-label': `${agentTitle(a.agent)}: ${label}` },
        h('header', null, h('h3', null, agentTitle(a.agent)), chip(label, a.state)),
        h('p', { class: 'activity', title: a.detail ?? '' }, activityText(a)),
        h(
          'dl',
          { class: 'stats' },
          h('div', null, h('dt', null, 'Tool calls'), h('dd', null, fmtCount(a.toolCalls))),
          h('div', null, h('dt', null, 'Errors'), h('dd', null, String(a.errors + a.toolErrors))),
          h('div', null, h('dt', null, 'Tokens'), h('dd', { title: `${a.inputTokens} in / ${a.outputTokens} out` }, `${fmtCount(a.inputTokens)}/${fmtCount(a.outputTokens)}`)),
          h('div', null, h('dt', null, 'Cost'), h('dd', null, fmtCost(a.costUsd))),
        ),
        h(
          'p',
          { class: 'meta' },
          a.taskId ? `Task ${short(a.taskId)} · ` : '',
          a.lastSeen ? ['Last event ', timeEl(a.lastSeen)] : 'Not seen yet',
        ),
      );
    });
  $('agents').replaceChildren(...cards);
}

/** [from, to] of an A2A event, from the reporting agent's point of view. */
function a2aRoute(e) {
  if (e.kind !== 'a2a') return [];
  const d = e.data;
  if (d.direction === 'receive') return [d.from ?? '?', e.agent];
  return [e.agent, d.to ?? '?'];
}

function emptyItem(text) {
  return h('li', { class: 'empty' }, text);
}

function newestFirst(kinds, ignoreContext = false) {
  const out = [];
  for (let i = state.events.length - 1; i >= 0 && out.length < LIST_LIMIT; i--) {
    const e = state.events[i];
    if (kinds.includes(e.kind) && matches(e, ignoreContext)) out.push(e);
  }
  return out.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
}

function renderA2A() {
  const items = newestFirst(['a2a']).map((e) => {
    const [from, to] = a2aRoute(e);
    const d = e.data;
    const verb = d.direction === 'receive' ? 'received' : 'sent';
    return h(
      'li',
      null,
      h(
        'div',
        { class: 'row-head' },
        timeEl(e.ts),
        h('span', { class: 'route' }, `${from} → ${to}`),
        d.state ? chip(d.state) : null,
        h('span', { class: 'muted' }, `${verb}, logged by ${e.agent}`),
        e.taskId ? h('span', { class: 'muted code', title: e.taskId }, `task ${short(e.taskId)}`) : null,
      ),
      d.text ? h('p', { class: 'message-text' }, clip(d.text, 400)) : null,
      disclosure(`a2a:${e.id}`, 'Message and data', h('pre', null, json({ taskId: e.taskId, contextId: e.contextId, ...d }))),
    );
  });
  $('a2a').replaceChildren(...(items.length ? items : [emptyItem('No A2A messages yet.')]));
}

function renderTelegram() {
  const list = $('telegram');
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  // Telegram messages carry no order id, so the order filter does not apply to the chat.
  const items = newestFirst(['telegram'], true)
    .reverse()
    .map((e) => {
      const d = e.data;
      const fromUser = d.direction === 'in';
      const text = d.blocked
        ? `(ignored a message from Telegram user ${d.fromId ?? 'unknown'}: not the allowed user)`
        : (d.text ?? '');
      return h(
        'li',
        { 'data-from': fromUser ? 'user' : 'bot' },
        h('div', { class: 'row-head' }, h('strong', null, fromUser ? 'You' : 'Bot'), timeEl(e.ts)),
        h('p', { class: d.blocked ? 'message-text muted' : 'message-text' }, text),
      );
    });
  list.replaceChildren(...(items.length ? items : [emptyItem('No Telegram messages yet.')]));
  if (nearBottom) list.scrollTop = list.scrollHeight;
}

function renderTools() {
  const results = new Map();
  for (const e of state.events) {
    if (e.kind === 'tool_result' && e.data.toolUseId) results.set(e.data.toolUseId, e);
  }
  const rows = newestFirst(['tool_call']).map((call) => {
    const d = call.data;
    const result = d.toolUseId ? results.get(d.toolUseId) : undefined;
    const status = d.denied ? 'denied' : !result ? 'running' : result.data.ok === false ? 'error' : 'ok';
    const detail = d.denied ?? result?.data.error ?? result?.data.output;
    const resultText = status === 'running' ? 'no result yet' : `result (${status}):\n${typeof detail === 'string' ? detail : json(detail)}`;
    return h(
      'tr',
      null,
      h('td', { class: 'nowrap' }, timeEl(call.ts)),
      h('td', { class: 'nowrap' }, call.agent),
      h('td', { class: 'code', title: d.tool ?? '' }, toolLabel(d.tool)),
      h(
        'td',
        { class: 'input code' },
        clip(d.input, 160),
        disclosure(
          `tool:${call.id}`,
          'Input and result',
          h('pre', null, `input:\n${d.input ?? ''}\n\n${resultText}`),
        ),
      ),
      h('td', null, chip(status)),
      h('td', { class: 'nowrap' }, fmtDuration(result?.data.durationMs)),
    );
  });
  $('tools').replaceChildren(
    ...(rows.length ? rows : [h('tr', null, h('td', { colspan: 6, class: 'empty' }, 'No tool calls yet.'))]),
  );
}

function renderErrors() {
  const items = newestFirst(['error', 'tool_result'])
    .filter((e) => e.kind === 'error' || e.data.ok === false)
    .map((e) => {
      const d = e.data;
      const title = e.kind === 'error' ? 'Error' : `Tool failed: ${toolLabel(d.tool)}`;
      const message = e.kind === 'error' ? d.message : d.error;
      return h(
        'li',
        null,
        h('div', { class: 'row-head' }, timeEl(e.ts), h('strong', null, e.agent), h('span', null, title)),
        h('p', { class: 'message-text' }, clip(message ?? '', 600)),
        disclosure(`err:${e.id}`, 'Details', h('pre', null, json({ taskId: e.taskId, contextId: e.contextId, ...d }))),
      );
    });
  $('errors').replaceChildren(...(items.length ? items : [emptyItem('No errors.')]));
}

function renderTasks() {
  const { agent, context } = state.filters;
  const rows = state.tasks
    // COS is the other side of every task, so filtering by COS keeps them all.
    .filter((t) => (!agent || agent === 'cos' || t.agent === agent) && (!context || t.contextId === context))
    .slice(0, LIST_LIMIT)
    .map((t) =>
      h(
        'tr',
        null,
        h(
          'td',
          { class: 'code' },
          h('span', { title: t.taskId }, short(t.taskId)),
          t.contextId && t.contextId !== context
            ? [' ', h('button', { type: 'button', class: 'link-button', onclick: () => setFilter('context', t.contextId) }, 'show order')]
            : null,
        ),
        h('td', null, t.agent),
        h('td', null, chip(t.state)),
        h('td', { class: 'nowrap' }, timeEl(t.lastTs)),
        h('td', null, clip(t.lastText ?? '', 160)),
      ),
    );
  $('tasks').replaceChildren(
    ...(rows.length ? rows : [h('tr', null, h('td', { colspan: 5, class: 'empty' }, 'No A2A tasks yet.'))]),
  );
}

function summarize(e) {
  const d = e.data;
  switch (e.kind) {
    case 'status':
      return `${d.state ?? ''}${d.detail ? `: ${d.detail}` : ''}`;
    case 'a2a': {
      const [from, to] = a2aRoute(e);
      return `${from} → ${to}${d.state ? ` [${d.state}]` : ''} ${d.text ?? ''}`;
    }
    case 'tool_call':
      return `${toolLabel(d.tool)}${d.denied ? ' (denied)' : ''}`;
    case 'tool_result':
      return `${toolLabel(d.tool)} ${d.ok === false ? 'failed' : 'ok'} ${fmtDuration(d.durationMs)}`;
    case 'llm':
      return `${d.model ?? ''}${d.text ? `: ${d.text}` : ''}`;
    case 'run':
      return `${d.subtype ?? ''} · ${d.numTurns ?? '?'} turns · ${d.inputTokens ?? 0} in / ${d.outputTokens ?? 0} out · ${fmtCost(d.costUsd ?? 0)}`;
    case 'telegram':
      return `${d.direction === 'in' ? 'user' : 'bot'}: ${d.text ?? ''}`;
    case 'error':
      return d.message ?? '';
    default:
      return d.text ?? '';
  }
}

function renderLog() {
  const kinds = state.filters.kind ? [state.filters.kind] : KINDS;
  const items = newestFirst(kinds).map((e) =>
    h(
      'li',
      null,
      disclosure(
        `log:${e.id}`,
        h('span', { class: 'row-head' }, timeEl(e.ts), h('strong', null, e.agent), chip(e.kind, 'neutral'), h('span', null, clip(summarize(e), 160))),
        h('pre', null, json(e)),
      ),
    ),
  );
  $('log').replaceChildren(...(items.length ? items : [emptyItem('No events match the filters.')]));
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    // Panels are rebuilt on every update; keep keyboard focus on the same disclosure.
    const focusedKey = document.activeElement?.closest?.('details[data-key]')?.dataset.key;
    renderFilterOptions();
    renderAgents();
    renderA2A();
    renderTelegram();
    renderTools();
    renderErrors();
    renderTasks();
    renderLog();
    if (focusedKey) document.querySelector(`details[data-key="${CSS.escape(focusedKey)}"] > summary`)?.focus();
  });
}

function setFilter(name, value) {
  state.filters[name] = value;
  scheduleRender();
}

// ---------- start ----------

function renderLinks(health) {
  const clawmetry = safeHref(health.clawmetryUrl);
  if (clawmetry) $('clawmetry-link').href = clawmetry;
  for (const shop of health.shops ?? []) {
    const href = safeHref(shop.url);
    if (href) $('links').append(h('li', null, h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, `Shop: ${shop.name}`)));
  }
}

async function start() {
  $('filters').addEventListener('submit', (ev) => ev.preventDefault());
  $('filter-agent').addEventListener('change', (ev) => setFilter('agent', ev.target.value));
  $('filter-context').addEventListener('change', (ev) => setFilter('context', ev.target.value));
  $('filter-kind').addEventListener('change', (ev) => setFilter('kind', ev.target.value));
  $('filter-clear').addEventListener('click', () => {
    state.filters = { agent: '', context: '', kind: '' };
    scheduleRender();
  });

  try {
    const [health, { events }] = await Promise.all([getJson('/api/health'), getJson(`/api/events?limit=${INITIAL_EVENTS}`)]);
    renderLinks(health);
    addEvents(events);
    await refreshDerived();
  } catch (err) {
    setConnection('down', `Could not load data from the hub: ${err.message}`);
  }
  scheduleRender();
  connect();
  setInterval(refreshDerived, AGENT_REFRESH_MS);
}

start();
