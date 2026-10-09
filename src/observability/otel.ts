/**
 * OpenTelemetry tracing exported over OTLP/HTTP (JSON) — by default to ClawMetry on :8900,
 * the OpenClaw observability dashboard. Spans follow the GenAI semantic conventions
 * (invoke_agent / execute_tool / chat) so ClawMetry maps tools, tokens and sessions.
 */
import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  trace,
  type Attributes,
  type Context,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BasicTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

export { SpanKind, SpanStatusCode, type Span, type Context };

export interface Tracing {
  tracer: Tracer;
  shutdown(): Promise<void>;
}

const noopTracing: Tracing = {
  tracer: trace.getTracer('noop'),
  shutdown: async () => {},
};

export function createTracing(serviceName: string, endpoint: string): Tracing {
  if (!endpoint) return noopTracing;
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: '0.1.0',
      'deployment.environment': 'local',
    }),
    spanProcessors: [
      new BatchSpanProcessor(
        new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/traces`, timeoutMillis: 3000 }),
        { scheduledDelayMillis: 1000 },
      ),
    ],
  });
  return {
    tracer: provider.getTracer(serviceName),
    shutdown: () => provider.shutdown().catch(() => {}),
  };
}

/** W3C traceparent of a span, to propagate across an A2A hop (carried in message metadata). */
export function toTraceparent(span: Span): string {
  const sc = span.spanContext();
  return `00-${sc.traceId}-${sc.spanId}-0${sc.traceFlags & TraceFlags.SAMPLED ? 1 : 0}`;
}

/** Parent context from a traceparent string (or ROOT when missing/invalid). */
export function contextFromTraceparent(traceparent: string | undefined): Context {
  const m = traceparent?.match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/);
  if (!m) return ROOT_CONTEXT;
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId: m[1]!,
    spanId: m[2]!,
    traceFlags: Number.parseInt(m[3]!, 16),
    isRemote: true,
  });
}

export function contextWithSpan(span: Span): Context {
  return trace.setSpan(ROOT_CONTEXT, span);
}

export function endSpan(span: Span, error?: unknown, attributes?: Attributes): void {
  if (attributes) span.setAttributes(attributes);
  if (error) {
    const message = error instanceof Error ? error.message : String(error);
    span.recordException(error instanceof Error ? error : new Error(message));
    span.setStatus({ code: SpanStatusCode.ERROR, message });
  } else {
    span.setStatus({ code: SpanStatusCode.OK });
  }
  span.end();
}
