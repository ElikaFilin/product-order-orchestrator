/**
 * Minimal OTLP/HTTP JSON trace receiver (stands in for ClawMetry): POST /v1/traces, flattens spans.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface CollectedSpan {
  service: string;
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId: string;
  kind: number;
  attributes: Record<string, unknown>;
  statusCode: number;
}

export interface OtlpCollector {
  url: string;
  spans: CollectedSpan[];
  /** Requests whose body could not be parsed as OTLP JSON. */
  rejected: number;
  /** What the rejected requests looked like (method, path, content type, body start). */
  rejectedSamples: string[];
  /** Non-export requests (e.g. the launcher's reachability check of CLAWMETRY_URL). */
  uiHits: number;
  reset(): void;
  close(): Promise<void>;
}

type KeyValue = { key: string; value?: Record<string, unknown> };

function attrValue(v: Record<string, unknown> | undefined): unknown {
  if (!v) return undefined;
  if ('stringValue' in v) return v.stringValue;
  if ('intValue' in v) return Number(v.intValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('boolValue' in v) return v.boolValue;
  return v;
}

function attrs(list: KeyValue[] | undefined): Record<string, unknown> {
  return Object.fromEntries((list ?? []).map((kv) => [kv.key, attrValue(kv.value)]));
}

export async function startOtlpCollector(): Promise<OtlpCollector> {
  const spans: CollectedSpan[] = [];
  const state = { rejected: 0, uiHits: 0 };
  const rejectedSamples: string[] = [];
  const server = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => {
      if (req.method !== 'POST' || !(req.url ?? '').startsWith('/v1/traces')) {
        // Anything else is a UI/reachability probe (the launcher checks CLAWMETRY_URL): answer like a web UI.
        state.uiHits += 1;
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('e2e OTLP receiver');
        return;
      }
      try {
        const body = JSON.parse(Buffer.concat(parts).toString('utf8')) as {
          resourceSpans?: Array<{
            resource?: { attributes?: KeyValue[] };
            scopeSpans?: Array<{ spans?: Array<Record<string, unknown>> }>;
          }>;
        };
        for (const rs of body.resourceSpans ?? []) {
          const service = String(attrs(rs.resource?.attributes)['service.name'] ?? '?');
          for (const ss of rs.scopeSpans ?? []) {
            for (const s of ss.spans ?? []) {
              spans.push({
                service,
                name: String(s.name),
                traceId: String(s.traceId),
                spanId: String(s.spanId),
                parentSpanId: String(s.parentSpanId ?? ''),
                kind: Number(s.kind ?? 0),
                attributes: attrs(s.attributes as KeyValue[] | undefined),
                statusCode: Number((s.status as { code?: number } | undefined)?.code ?? 0),
              });
            }
          }
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      } catch (err) {
        state.rejected += 1;
        if (rejectedSamples.length < 5) {
          const head = Buffer.concat(parts).subarray(0, 120).toString('utf8');
          rejectedSamples.push(`${req.method} ${req.url} ${req.headers['content-type']} ${req.headers['content-encoding'] ?? ''}: ${String(err)} :: ${head}`);
        }
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{}');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    spans,
    get rejected() {
      return state.rejected;
    },
    rejectedSamples,
    get uiHits() {
      return state.uiHits;
    },
    reset() {
      spans.length = 0;
      state.rejected = 0;
      state.uiHits = 0;
      rejectedSamples.length = 0;
    },
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
