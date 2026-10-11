/**
 * THROWAWAY headless Chrome for the e2e run: its own fresh --user-data-dir, its own debugging port,
 * killed (whole process group) and deleted afterwards. Never the user's own Chrome or its profiles.
 * Also a minimal CDP client so the harness can seed and read the Tilda basket (localStorage "tcart").
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

export const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export interface CartLine {
  name: string;
  qty: number;
}

interface TargetInfo {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export class CdpPage {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();

  private constructor(
    readonly targetId: string,
    private readonly ws: WebSocket,
    private readonly http: string,
  ) {
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } };
      if (msg.id === undefined) return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    });
    ws.addEventListener('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('CDP socket closed'));
      this.pending.clear();
    });
  }

  static async open(http: string, url: string): Promise<CdpPage> {
    const res = await fetch(`${http}/json/new?${encodeURI(url)}`, { method: 'PUT' });
    if (!res.ok) throw new Error(`CDP /json/new failed: HTTP ${res.status}`);
    const target = (await res.json()) as TargetInfo;
    if (!target.webSocketDebuggerUrl) throw new Error('CDP target without webSocketDebuggerUrl');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP socket error')), { once: true });
    });
    return new CdpPage(target.id, ws, http);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluate an expression in the page (awaits promises) and return its JSON value. */
  async evaluate<T>(expression: string, timeoutMs = 60_000): Promise<T> {
    const result = (await Promise.race([
      this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
      sleep(timeoutMs, undefined, { ref: false }).then(() => {
        throw new Error(`CDP evaluate timed out after ${timeoutMs} ms`);
      }),
    ])) as { result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
    if (result.exceptionDetails) {
      throw new Error(`page exception: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    }
    return result.result?.value as T;
  }

  async waitFor(expression: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (await this.evaluate<boolean>(`Boolean(${expression})`, 5_000)) return true;
      } catch {
        // navigation in progress: the context is being replaced
      }
      await sleep(250);
    }
    return false;
  }

  async close(): Promise<void> {
    try {
      this.ws.close();
    } catch {
      // already closed
    }
    await fetch(`${this.http}/json/close/${this.targetId}`).catch(() => undefined);
  }
}

export class ThrowawayChrome {
  private constructor(
    readonly port: number,
    readonly profileDir: string,
    private readonly child: ChildProcess,
  ) {}

  get cdpUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  static async start(opts: { port: number; profileDir: string; logFile: string; chromePath?: string }): Promise<ThrowawayChrome> {
    const chrome = opts.chromePath ?? DEFAULT_CHROME;
    if (!existsSync(chrome)) throw new Error(`Chrome not found at ${chrome} (set CHROME_PATH)`);
    mkdirSync(opts.profileDir, { recursive: true });
    const fd = openSync(opts.logFile, 'a');
    const child = spawn(
      chrome,
      [
        '--headless=new',
        `--remote-debugging-port=${opts.port}`,
        '--remote-debugging-address=127.0.0.1',
        `--user-data-dir=${opts.profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-sync',
        '--disable-extensions',
        '--disable-component-update',
        '--password-store=basic',
        '--use-mock-keychain',
        '--window-size=1280,900', // >= 980 px: Tilda shows the floating cart icon at the top right
        'about:blank',
      ],
      { stdio: ['ignore', fd, fd], detached: true }, // own process group: killed as a whole afterwards
    );
    closeSync(fd);
    const browser = new ThrowawayChrome(opts.port, opts.profileDir, child);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`throwaway Chrome exited early (code ${child.exitCode}); see ${opts.logFile}`);
      try {
        const res = await fetch(`${browser.cdpUrl}/json/version`, { signal: AbortSignal.timeout(1_000) });
        if (res.ok) return browser;
      } catch {
        // not up yet
      }
      await sleep(200);
    }
    await browser.stop();
    throw new Error(`throwaway Chrome did not open its debugging port ${opts.port}`);
  }

  async version(): Promise<string> {
    const res = await fetch(`${this.cdpUrl}/json/version`);
    return ((await res.json()) as { Browser?: string }).Browser ?? 'unknown';
  }

  async pages(): Promise<TargetInfo[]> {
    const res = await fetch(`${this.cdpUrl}/json/list`);
    return ((await res.json()) as TargetInfo[]).filter((t) => t.type === 'page');
  }

  openPage(url: string): Promise<CdpPage> {
    return CdpPage.open(this.cdpUrl, url);
  }

  /**
   * The basket as Tilda stores it: localStorage "tcart" of the shop origin, read from a same-origin page that
   * runs no shop scripts (robots.txt), so reading cannot change it. Deleted lines linger with deleted:"yes".
   */
  async readCart(origin: string): Promise<{ lines: CartLine[]; raw: unknown }> {
    const page = await this.openPage(`${origin}/robots.txt`);
    try {
      await page.waitFor(`document.readyState === 'complete' && location.origin === ${JSON.stringify(origin)}`, 30_000);
      const raw = await page.evaluate<string | null>(`localStorage.getItem('tcart')`);
      const data = raw ? (JSON.parse(raw) as { products?: Array<Record<string, unknown>> }) : null;
      const lines = (data?.products ?? [])
        .filter((p) => p && p.name && p.deleted !== 'yes' && Number(p.quantity) > 0)
        .map((p) => ({ name: String(p.name), qty: Number(p.quantity) }));
      return { lines, raw: data };
    } finally {
      await page.close();
    }
  }

  /**
   * Open `url` the way the user's click on the link would (a full page load in a new tab) and read the cart
   * window with the shop's helper. Read-only: nothing is clicked. Returns null when the window never opened.
   */
  async openCartLink(url: string, helperSource: string): Promise<{ open: boolean; lines: CartLine[] } | null> {
    const page = await this.openPage('about:blank');
    try {
      await page.send('Page.navigate', { url }); // keeps the #fragment (a /json/new?<url> request would drop it)
      const opened = await page.waitFor(`document.querySelector('.t706__cartwin.t706__cartwin_showed')`, 30_000);
      if (!opened) return null;
      await sleep(500);
      const modal = await page.evaluate<{ open: boolean; lines: Array<{ name: string; qty: number }> }>(
        `(() => { ${helperSource}\n return window.__poo.readModal(); })()`,
      );
      return { open: modal.open, lines: modal.lines.map((l) => ({ name: l.name, qty: l.qty })) };
    } finally {
      await page.close();
    }
  }

  /** Run the shop's in-page helper on a fresh shop tab (used to pre-seed the basket), then close the tab. */
  async withShopHelper<T>(baseUrl: string, helperSource: string, expression: string): Promise<T> {
    const page = await this.openPage(baseUrl);
    try {
      const loaded = await page.waitFor(`document.readyState === 'complete' && window.tcart_initted === 'yes'`, 60_000);
      if (!loaded) throw new Error(`the shop page ${baseUrl} did not finish loading in the throwaway Chrome`);
      return await page.evaluate<T>(`(async () => { ${helperSource}\n return await (${expression}); })()`, 90_000);
    } finally {
      await page.close();
    }
  }

  async stop(): Promise<void> {
    const pid = this.child.pid;
    if (pid !== undefined && this.child.exitCode === null && this.child.signalCode === null) {
      const exited = new Promise<void>((r) => this.child.once('exit', () => r()));
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        // group already gone
      }
      await Promise.race([exited, sleep(5_000, undefined, { ref: false })]);
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // group already gone
      }
    }
    await rm(this.profileDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
