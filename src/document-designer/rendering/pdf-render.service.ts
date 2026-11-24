/**
 * @fileoverview Headless-Chromium PDF rendering for document exports. Owns a
 * lazy singleton Puppeteer browser (relaunched on disconnect), a hand-rolled
 * promise semaphore capping concurrent renders, and a per-page request
 * interception allowlist (data: URIs + the Supabase host only) so template
 * HTML can never make the export worker call arbitrary hosts (SSRF control —
 * see the DocImageSrc contract in template-definition.types).
 *
 * Deployment note: the Docker image installs the distro chromium and sets
 * PUPPETEER_EXECUTABLE_PATH / PUPPETEER_SKIP_DOWNLOAD; local dev uses the
 * Chrome that `pnpm install` downloads (or 501s when neither is available).
 *
 * IMPORT NOTE: puppeteer is ESM-only with an engines floor of Node >=22.12 —
 * a STATIC import would load at every backend boot (this module is registered
 * unconditionally) and crash the whole app with ERR_REQUIRE_ESM on older Node
 * hosts, even with DOCUMENT_PDF_ENABLED=false. It is therefore loaded LAZILY
 * via dynamic import() inside the launch path only; import failures surface
 * as the same 501 as a failed browser launch.
 * @module src/document-designer/rendering/pdf-render.service
 */

import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Browser } from 'puppeteer';

export interface IPdfPageSize {
  widthPx: number;
  heightPx: number;
}

export interface IPdfRenderOptions {
  /** Chromium footer template, drawn in the page's bottom margin; supports `.pageNumber` / `.totalPages`. */
  footerHtml?: string;
  /** Overrides DOCUMENT_PDF_TIMEOUT_MS for long reports. */
  timeoutMs?: number;
}

/** Renders queued beyond the active slots before we start rejecting with 429. */
const MAX_QUEUE_DEPTH = 10;

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_TIMEOUT_MS = 30_000;

@Injectable()
export class PdfRenderService implements OnModuleDestroy {
  private readonly logger = new Logger(PdfRenderService.name);

  /** Lazy singleton browser launch (cleared on disconnect / launch failure). */
  private browserPromise: Promise<Browser> | null = null;

  /** Promise semaphore state: active render count + FIFO waiter queue. */
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly configService: ConfigService) {}

  // ── Config ────────────────────────────────────────────────────────────────

  private get enabled(): boolean {
    const raw = this.configService.get<string>('DOCUMENT_PDF_ENABLED');
    return (raw ?? 'true').toLowerCase() !== 'false';
  }

  private get concurrency(): number {
    const raw = this.configService.get<string>('DOCUMENT_PDF_CONCURRENCY');
    const parsed = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CONCURRENCY;
  }

  private get timeoutMs(): number {
    const raw = this.configService.get<string>('DOCUMENT_PDF_TIMEOUT_MS');
    const parsed = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
  }

  /** Host of the Supabase project — the only remote host pages may fetch. */
  private get supabaseHost(): string | null {
    const url = this.configService.get<string>('supabase.url');
    if (!url) return null;
    try {
      return new URL(url).host;
    } catch {
      return null;
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Render a self-contained HTML document (as emitted by
   * DocumentRenderService — it carries its own `@page { size … margin: 0 }`
   * rule) to a PDF buffer.
   *
   * `additionalAllowedHosts` widens the request-interception allowlist beyond
   * the Supabase host for THIS render only — pass the exact hostnames of any
   * `url`-kind image sources actually present in the template being
   * rendered (never a blanket "allow all"), so a template can only ever
   * reach the specific external hosts its own author already referenced.
   */
  async renderPdf(
    html: string,
    page: IPdfPageSize,
    additionalAllowedHosts?: readonly string[],
    options?: IPdfRenderOptions,
  ): Promise<Buffer> {
    if (!this.enabled) {
      throw new HttpException(
        'PDF rendering is not available on this deployment',
        HttpStatus.NOT_IMPLEMENTED,
      );
    }

    await this.acquire();
    try {
      const browser = await this.getBrowserWithRetry();
      return await this.renderWithBrowser(
        browser,
        html,
        page,
        additionalAllowedHosts,
        options,
      );
    } finally {
      this.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    const pending = this.browserPromise;
    this.browserPromise = null;
    if (!pending) return;
    try {
      const browser = await pending;
      await browser.close();
    } catch {
      // Browser already gone — nothing to clean up.
    }
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  private async renderWithBrowser(
    browser: Browser,
    html: string,
    page: IPdfPageSize,
    additionalAllowedHosts?: readonly string[],
    options?: IPdfRenderOptions,
  ): Promise<Buffer> {
    const timeout = options?.timeoutMs ?? this.timeoutMs;
    const context = await browser.createBrowserContext();
    try {
      const tab = await context.newPage();

      const allowedHost = this.supabaseHost;
      const extraHosts = new Set(additionalAllowedHosts ?? []);
      await tab.setRequestInterception(true);
      tab.on('request', (request) => {
        const url = request.url();
        const host = this.hostOf(url);
        const isAllowed =
          url.startsWith('data:') ||
          url.startsWith('about:') ||
          (allowedHost !== null && host === allowedHost) ||
          (host !== null && extraHosts.has(host));
        if (isAllowed) {
          void request.continue().catch(() => undefined);
        } else {
          void request.abort().catch(() => undefined);
        }
      });

      // Puppeteer 23+ removed networkidle from setContent — wait for 'load'
      // then settle remaining (signed-URL image) requests via network idle.
      await tab.setContent(html, { waitUntil: 'load', timeout });
      await tab
        .waitForNetworkIdle({ idleTime: 500, timeout })
        .catch(() => undefined);

      // Boxes never grow/reflow (some sit on exactly-sized background shapes) — instead
      // shrink overflowing text down to a floor size. Real layout (scrollHeight/clientHeight)
      // is only available once Chromium has rendered the page, hence doing this here rather
      // than in DocumentRenderService. Covers every item/page: html/setContent above already
      // contains the full multi-item document, not one page per call.
      await tab.evaluate(() => {
        const FLOOR_PX = 8;
        const MAX_ITERATIONS = 15;

        // Flow boxes (task lists) grow with their content — never shrink them.
        document.querySelectorAll('.el:not(.el-flow)').forEach((node) => {
          const el = node as HTMLElement;
          if (el.scrollHeight <= el.clientHeight) return;

          let fontSize = parseFloat(
            el.style.fontSize || window.getComputedStyle(el).fontSize,
          );
          if (!Number.isFinite(fontSize)) return;

          let iterations = 0;
          while (
            el.scrollHeight > el.clientHeight &&
            fontSize > FLOOR_PX &&
            iterations < MAX_ITERATIONS
          ) {
            fontSize -= 1;
            el.style.fontSize = `${fontSize}px`;
            iterations += 1;
          }

          // Shrinking to the floor still isn't enough for some pathologically
          // long content. `-webkit-line-clamp` looked right in live-page
          // measurements but doesn't reliably suppress overflow once Chromium
          // switches to print layout for tab.pdf() — so trim the actual text
          // content instead, which is guaranteed correct under any renderer.
          if (el.scrollHeight > el.clientHeight) {
            const textNodes: Text[] = [];
            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            let node: Node | null;
            while ((node = walker.nextNode())) {
              if (node.nodeValue && node.nodeValue.trim().length > 0) {
                textNodes.push(node as Text);
              }
            }

            // The ellipsis itself must be part of every measurement below —
            // appending it only after the box already "fits" can push the
            // box back over by that one character, clipping the ellipsis too.
            const ellipsis = '…';
            let cursor = textNodes.length - 1;
            let guard = 0;
            while (
              el.scrollHeight > el.clientHeight &&
              cursor >= 0 &&
              guard < 2000
            ) {
              const current = textNodes[cursor];
              const value = current.nodeValue ?? '';
              const base = value.endsWith(ellipsis)
                ? value.slice(0, -ellipsis.length)
                : value;
              if (base.length === 0) {
                current.nodeValue = '';
                cursor -= 1;
                continue;
              }
              current.nodeValue = base.slice(0, -1) + ellipsis;
              guard += 1;
            }
          }
        });
      });

      // The HTML carries `@page { size: <w>px <h>px; margin: 0 }`, which
      // preferCSSPageSize honours; the explicit width/height are a fallback
      // for definitions that somehow lost the rule.
      const pdf = await tab.pdf({
        printBackground: true,
        preferCSSPageSize: true,
        width: `${page.widthPx}px`,
        height: `${page.heightPx}px`,
        timeout,
        ...(options?.footerHtml
          ? {
              displayHeaderFooter: true,
              headerTemplate: '<span></span>',
              footerTemplate: options.footerHtml,
            }
          : {}),
      });

      return Buffer.from(pdf);
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  private hostOf(url: string): string | null {
    try {
      return new URL(url).host;
    } catch {
      return null;
    }
  }

  // ── Browser lifecycle ─────────────────────────────────────────────────────

  private async getBrowserWithRetry(): Promise<Browser> {
    try {
      return await this.getBrowser();
    } catch (firstError) {
      this.logger.warn(
        `Browser launch failed, retrying once: ${String(firstError)}`,
      );
      try {
        return await this.getBrowser();
      } catch (secondError) {
        this.logger.error(
          `Browser launch failed twice: ${String(secondError)}`,
        );
        throw new HttpException(
          'PDF rendering is not available on this deployment',
          HttpStatus.NOT_IMPLEMENTED,
        );
      }
    }
  }

  private getBrowser(): Promise<Browser> {
    if (!this.browserPromise) {
      this.browserPromise = this.launchBrowser().catch((err) => {
        // A failed launch must not poison the singleton slot.
        this.browserPromise = null;
        throw err;
      });
    }
    return this.browserPromise;
  }

  /**
   * Lazy dynamic import — see the module-header IMPORT NOTE. Kept as its own
   * method so specs can assert the import is never attempted while PDF
   * rendering is disabled.
   */
  private async loadPuppeteer(): Promise<
    (typeof import('puppeteer'))['default']
  > {
    const mod = await import('puppeteer');
    return mod.default;
  }

  private async launchBrowser(): Promise<Browser> {
    const puppeteer = await this.loadPuppeteer().catch((err: unknown) => {
      this.logger.error(`Failed to load puppeteer: ${String(err)}`);
      throw err instanceof Error ? err : new Error(String(err));
    });

    const executablePath =
      this.configService.get<string>('PUPPETEER_EXECUTABLE_PATH') || undefined;

    const browser = await puppeteer.launch({
      headless: true,
      executablePath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--font-render-hinting=medium',
      ],
    });

    browser.on('disconnected', () => {
      this.browserPromise = null;
    });

    return browser;
  }

  // ── Promise semaphore ─────────────────────────────────────────────────────

  private async acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active += 1;
      return;
    }

    if (this.waiters.length >= MAX_QUEUE_DEPTH) {
      throw new HttpException(
        'PDF rendering queue is full — too many concurrent exports; retry in a moment',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Hand the slot straight to the next waiter — `active` stays the same.
      next();
    } else {
      this.active = Math.max(0, this.active - 1);
    }
  }
}
