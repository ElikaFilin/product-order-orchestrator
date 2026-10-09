/**
 * One telemetry facade per process. It fans every event out to:
 *  - the built-in dashboard hub (HTTP POST, batched, fire-and-forget) for the live agent board, and
 *  - OpenTelemetry spans (OTLP → ClawMetry) for trace trees, tokens and cost.
 * Telemetry must never break an agent: every network call swallows its own errors.
 */
import { randomUUID } from 'node:crypto';
import type { Attributes } from '@opentelemetry/api';
import { env } from '../config/env.js';
import { createLogger, errorMessage } from '../shared/logger.js';
import type { AgentState, ObsEvent, ObsIds, ObsKind } from './events.js';
import {
  contextFromTraceparent,
  contextWithSpan,
  createTracing,
  endSpan,
  SpanKind,
  toTraceparent,
  type Span,
  type Tracing,
} from './otel.js';

export { SpanKind };

const FLUSH_MS = 250;
const MAX_QUEUE = 5_000;
const PREVIEW_CHARS = 2_000;

/** Short, JSON-safe preview of an arbitrary value for dashboards. */
export function preview(value: unknown, max = PREVIEW_CHARS): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined) return '';
  return text.length > max ? `${text.slice(0, max)}… (+${text.length - max} chars)` : text;
}

export interface SpanHandle {
  span: Span;
  traceparent: string;
  traceId: string;
  end(error?: unknown, attributes?: Attributes): void;
}

export class Telemetry {
  private readonly log: ReturnType<typeof createLogger>;
  private readonly queue: ObsEvent[] = [];
  private timer: NodeJS.Timeout | undefined;
  private readonly hubUrl: string | undefined;
  private readonly tracing: Tracing;
  private lastState: AgentState | undefined;

  constructor(readonly agent: string) {
    this.log = createLogger(`telemetry:${agent}`);
    const e = env();
    this.hubUrl = e.DASHBOARD_ENABLED ? `http://${e.DASHBOARD_HOST}:${e.DASHBOARD_PORT}/api/events` : undefined;
    this.tracing = createTracing(`poo-${agent}`, e.OTEL_EXPORTER_OTLP_ENDPOINT);
  }

  // ---------- dashboard events ----------

  emit(kind: ObsKind, data: Record<string, unknown>, ids: ObsIds = {}): void {
    const event: ObsEvent = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      agent: this.agent,
      kind,
      ...ids,
      data,
    };
    this.log.debug({ kind, ids, data }, 'event');
    if (!this.hubUrl) return;
    if (this.queue.length >= MAX_QUEUE) this.queue.shift();
    this.queue.push(event);
    this.timer ??= setTimeout(() => void this.flush(), FLUSH_MS);
    this.timer.unref?.();
  }

  status(state: AgentState, detail?: string, ids: ObsIds = {}): void {
    this.lastState = state;
    this.emit('status', { state, detail }, ids);
  }

  get state(): AgentState | undefined {
    return this.lastState;
  }

  error(err: unknown, context: Record<string, unknown> = {}, ids: ObsIds = {}): void {
    const message = errorMessage(err);
    this.log.error({ err, ...context }, message);
    this.emit('error', { message, stack: err instanceof Error ? err.stack : undefined, ...context }, ids);
  }

  async flush(): Promise<void> {
    this.timer = undefined;
    if (!this.hubUrl || this.queue.length === 0) return;
    const batch = this.queue.splice(0, 500);
    try {
      const res = await fetch(this.hubUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(2_000),
      });
      if (!res.ok) this.log.debug({ status: res.status }, 'dashboard rejected events');
    } catch (err) {
      this.log.debug({ err: errorMessage(err) }, 'dashboard unreachable; events dropped');
    }
    if (this.queue.length > 0) this.timer ??= setTimeout(() => void this.flush(), FLUSH_MS);
  }

  // ---------- tracing ----------

  /**
   * Start a span. `parent` is either a traceparent string (remote parent from an A2A message)
   * or a SpanHandle in this process.
   */
  startSpan(
    name: string,
    attributes: Attributes = {},
    parent?: string | SpanHandle,
    kind: SpanKind = SpanKind.INTERNAL,
  ): SpanHandle {
    const ctx =
      parent === undefined
        ? undefined
        : typeof parent === 'string'
          ? contextFromTraceparent(parent)
          : contextWithSpan(parent.span);
    const span = this.tracing.tracer.startSpan(
      name,
      { kind, attributes: { 'gen_ai.agent.name': this.agent, ...attributes } },
      ctx,
    );
    return {
      span,
      traceparent: toTraceparent(span),
      traceId: span.spanContext().traceId,
      end: (error?: unknown, attrs?: Attributes) => endSpan(span, error, attrs),
    };
  }

  async shutdown(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    await this.flush();
    await this.tracing.shutdown();
  }
}
