/**
 * Probe of a Chrome DevTools Protocol endpoint: a browser started with --remote-debugging-port
 * (BROWSER_MODE=cdp, the throwaway Chrome of the smoke and e2e tests).
 */
import { errorMessage } from '../shared/logger.js';

export interface CdpStatus {
  ok: boolean;
  url: string;
  /** e.g. "Chrome/155.0.8059.40". */
  browser?: string;
  userAgent?: string;
  webSocketDebuggerUrl?: string;
  error?: string;
}

export async function checkCdp(url: string, timeoutMs = 2_000): Promise<CdpStatus> {
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, url, error: `HTTP ${res.status} from ${url}/json/version` };
    const body = (await res.json()) as Record<string, string | undefined>;
    return {
      ok: true,
      url,
      browser: body.Browser,
      userAgent: body['User-Agent'],
      webSocketDebuggerUrl: body.webSocketDebuggerUrl,
    };
  } catch (err) {
    return { ok: false, url, error: errorMessage(err) };
  }
}
