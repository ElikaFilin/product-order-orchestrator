/**
 * Local stand-in for the Anthropic Messages API (POST /v1/messages, streaming SSE like the real API).
 * A `policy` decides every reply from the request body alone (system prompt + conversation so far),
 * so concurrent Claude Code processes of different agents can share one mock. Never logs header values.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type MockReply =
  | { kind: 'tool_use'; name: string; input: Record<string, unknown>; text?: string }
  | { kind: 'text'; text: string };

export interface PolicyResult {
  /** Which scripted agent answered ('side' for requests that are not an agent turn). */
  agent: string;
  reply: MockReply;
}

export interface CapturedRequest {
  seq: number;
  at: string;
  agent: string;
  model: string;
  body: Record<string, unknown>;
  reply?: MockReply;
  error?: string;
  hadApiKey: boolean;
}

export interface MockAnthropic {
  url: string;
  requests: CapturedRequest[];
  close(): Promise<void>;
}

let toolSeq = 0;

function sse(res: http.ServerResponse, type: string, data: unknown): void {
  res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Split a string into a few chunks, like the real API streams partial JSON / text deltas. */
function chunks(text: string, size = 48): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [''];
}

function usage(body: Record<string, unknown>): { input_tokens: number; output_tokens: number } {
  // Roughly proportional to the request, so the CLI's cost accounting moves like it would for real.
  const approx = Math.ceil(JSON.stringify(body.messages ?? []).length / 8);
  return { input_tokens: Math.min(Math.max(approx, 200), 20_000), output_tokens: 60 };
}

function writeStream(res: http.ServerResponse, model: string, body: Record<string, unknown>, reply: MockReply, msgId: string): void {
  const u = usage(body);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': `req_${msgId}` });
  sse(res, 'message_start', {
    type: 'message_start',
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: u.input_tokens, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  });
  sse(res, 'ping', { type: 'ping' });
  let index = 0;
  const text = reply.text ?? '';
  // An empty end of turn comes back like the real API's: no content block at all.
  if (text.length > 0) {
    sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
    for (const part of chunks(text)) {
      sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: part } });
    }
    sse(res, 'content_block_stop', { type: 'content_block_stop', index });
    index += 1;
  }
  if (reply.kind === 'tool_use') {
    sse(res, 'content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', id: `toolu_e2e_${++toolSeq}`, name: reply.name, input: {} },
    });
    for (const part of chunks(JSON.stringify(reply.input))) {
      sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: part } });
    }
    sse(res, 'content_block_stop', { type: 'content_block_stop', index });
  }
  sse(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: reply.kind === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: u.output_tokens },
  });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

function writeJson(res: http.ServerResponse, model: string, body: Record<string, unknown>, reply: MockReply, msgId: string): void {
  const content: unknown[] = [];
  if (reply.kind === 'text') {
    if (reply.text) content.push({ type: 'text', text: reply.text });
  } else {
    if (reply.text) content.push({ type: 'text', text: reply.text });
    content.push({ type: 'tool_use', id: `toolu_e2e_${++toolSeq}`, name: reply.name, input: reply.input });
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      id: msgId,
      type: 'message',
      role: 'assistant',
      model,
      content,
      stop_reason: reply.kind === 'tool_use' ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      usage: { ...usage(body), cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    }),
  );
}

export function startMockAnthropic(policy: (body: Record<string, unknown>) => PolicyResult): Promise<MockAnthropic> {
  const requests: CapturedRequest[] = [];
  let seq = 0;
  const server = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(parts).toString('utf8');
      let body: Record<string, unknown> | undefined;
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
      } catch {
        body = undefined;
      }
      const pathname = (req.url ?? '').split('?')[0];
      const hadApiKey = typeof req.headers['x-api-key'] === 'string' || typeof req.headers.authorization === 'string';
      if (!hadApiKey) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'mock: no credentials' } }));
        return;
      }
      if (pathname === '/v1/messages/count_tokens') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 1000 }));
        return;
      }
      if (req.method !== 'POST' || pathname !== '/v1/messages' || !body) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `mock: ${req.method} ${pathname}` } }));
        return;
      }
      const model = String(body.model ?? 'mock');
      const captured: CapturedRequest = { seq: ++seq, at: new Date().toISOString(), agent: '?', model, body, hadApiKey };
      requests.push(captured);
      let decided: PolicyResult;
      try {
        decided = policy(body);
      } catch (err) {
        captured.error = err instanceof Error ? (err.stack ?? err.message) : String(err);
        decided = { agent: 'error', reply: { kind: 'text', text: `MOCK POLICY ERROR: ${captured.error.split('\n')[0]}` } };
      }
      captured.agent = decided.agent;
      captured.reply = decided.reply;
      const msgId = `msg_e2e_${captured.seq}`;
      if (body.stream === true) writeStream(res, model, body, decided.reply, msgId);
      else writeJson(res, model, body, decided.reply, msgId);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });
}
