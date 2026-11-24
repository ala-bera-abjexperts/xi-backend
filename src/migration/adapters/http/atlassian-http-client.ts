/**
 * @fileoverview The single egress choke point for all Atlassian API calls.
 *
 * Centralizes: auth injection, JSON Accept headers, request timeouts, 429 `Retry-After`
 * handling, exponential backoff + jitter on 5xx/network errors, and fail-fast on other 4xx.
 * Pagination iterators (offset / cursor / token) are layered on in Phase 1.
 *
 * Instances are per-connection so a future per-connection rate limiter can bind here.
 */

import { createWriteStream } from 'fs';
import { unlink } from 'fs/promises';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import type { ReadableStream as WebReadableStream } from 'stream/web';
import { UPLOAD_LIMITS } from '../../../common/upload-limits';
import {
  describeFetchFailure,
  isTlsChainFailure,
} from '../../../common/utils/fetch-failure.util';
import { Logger } from '@nestjs/common';
import type { IAuthStrategy } from '../source-adapter.interface';
import { validateBaseUrl } from './url-safety';

export interface AtlassianHttpOptions {
  /** Per-request timeout (ms). */
  timeoutMs?: number;
  /** Max retry attempts for transient failures (429 / 5xx / network). */
  maxRetries?: number;
  /** If set, `Host` header is left as-is but requests are pinned to this IP (anti DNS-rebind). Reserved for Phase 1+. */
  pinnedIp?: string;
  /** Allow RFC1918 / unique-local redirect targets (on-prem). Used to re-validate attachment 3xx targets. */
  allowPrivateNetworks?: boolean;
  /** Allow plain-HTTP redirect targets (on-prem). Used to re-validate attachment 3xx targets. */
  allowInsecureHttp?: boolean;
  /** Context path of the configured base URL (`/jira`); relative API paths are prefixed with it. */
  basePath?: string;
}

/** Attachment byte downloads may redirect (Jira Cloud 303s to a pre-signed media URL); cap the chain. */
const MAX_BYTE_REDIRECTS = 4;

/**
 * Identifies this integration to the source instance. Set EXPLICITLY and neutrally: without it the
 * runtime supplies its own default, and the value ends up in the customer's Atlassian audit log. It
 * must never carry machine, OS or operator details — only the product and a version.
 */
const USER_AGENT = 'xisuite-migration/1.0';

export interface HttpResponse<T = unknown> {
  ok: boolean;
  status: number;
  body: T;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 4;

/** A non-2xx response that is NOT retryable (auth/permission/not-found/bad-request). */
export class AtlassianRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly bodyText?: string,
  ) {
    super(message);
    this.name = 'AtlassianRequestError';
  }
}

/** Internal marker that keeps byte-download transport faults retryable without changing worker errors. */
class ByteDownloadNetworkError extends AtlassianRequestError {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message, 0);
  }
}

export class AtlassianHttpClient {
  private readonly logger = new Logger(AtlassianHttpClient.name);
  private readonly origin: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly allowPrivateNetworks: boolean;
  private readonly allowInsecureHttp: boolean;
  private readonly basePath: string;

  constructor(
    origin: string,
    private readonly auth: IAuthStrategy,
    options: AtlassianHttpOptions = {},
  ) {
    this.origin = origin.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.allowPrivateNetworks = options.allowPrivateNetworks === true;
    this.allowInsecureHttp = options.allowInsecureHttp === true;
    this.basePath = (options.basePath ?? '').replace(/\/+$/, '');
  }

  /** The validated request origin — callers pin absolute download URLs to it (SSRF guard). */
  get requestOrigin(): string {
    return this.origin;
  }

  /**
   * The absolute request path for a caller-supplied one: prefixed with the configured context
   * path (`/jira`) unless it already carries it. Two callers already do: absolute attachment URLs
   * returned by the source (the adapter keeps only their path, which includes the context path),
   * and the Confluence Cloud adapter's hardcoded `/wiki/…` paths when the operator typed `…/wiki`
   * as the base URL. Without a context path this is the identity, byte-for-byte what shipped.
   */
  private resolvePath(path: string): string {
    const p = path.startsWith('/') ? path : `/${path}`;

    if (!this.basePath) return p;
    if (p === this.basePath || p.startsWith(`${this.basePath}/`)) return p;

    return this.basePath + p;
  }

  /** GET a path (relative to the base URL) and parse JSON. Throws AtlassianRequestError on non-2xx. */
  async getJson<T>(path: string): Promise<T> {
    const res = await this.request<T>('GET', path);

    if (!res.ok) {
      // The full path, so a customer's screenshot of this message is unambiguous about what was asked for.
      throw new AtlassianRequestError(
        `GET ${this.resolvePath(path)} failed with ${res.status}`,
        res.status,
      );
    }

    return res.body;
  }

  /**
   * GET raw bytes (with auth + timeout) — for streaming attachment downloads. Bounded by
   * `maxBytes` (default 50 MB); throws `AtlassianRequestError` on non-2xx or oversize. Transient
   * header failures use the same bounded retry policy as JSON requests before the body is read.
   */
  async getBytes(
    path: string,
    maxBytes = UPLOAD_LIMITS.ATTACHMENT,
  ): Promise<{ data: Buffer; contentType: string | null; size: number }> {
    const response = await this.openByteResponse(path, maxBytes, () =>
      AbortSignal.timeout(this.timeoutMs * 4),
    );
    const data = Buffer.from(await response.arrayBuffer());

    if (data.byteLength > maxBytes) {
      throw new AtlassianRequestError(
        `Attachment ${path} is ${data.byteLength} bytes (> ${maxBytes} cap)`,
        413,
      );
    }

    return {
      data,
      contentType: response.headers.get('content-type'),
      size: data.byteLength,
    };
  }

  /**
   * GET raw bytes streamed straight to `destFilePath` — the large-attachment path. The body never
   * touches the heap, so files past Node's ~4 GiB Buffer cap work. Same redirect/SSRF/auth-strip
   * semantics as `getBytes`. Headers get the same per-hop budget as `getBytes`; the BODY is bounded
   * by an IDLE timeout re-armed per chunk instead of a total budget (a 5 GB file legitimately
   * outlives any fixed budget, while a stalled socket must not hang the worker). Oversize → typed
   * 413. On any failure the partial file is deleted.
   */
  async getBytesToFile(
    path: string,
    destFilePath: string,
    maxBytes = UPLOAD_LIMITS.ATTACHMENT,
  ): Promise<{ contentType: string | null; size: number }> {
    let abort = new AbortController();
    let timer: NodeJS.Timeout | null = null;
    const arm = (ms: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => abort.abort(), ms);
    };

    try {
      const response = await this.openByteResponse(path, maxBytes, () => {
        if (abort.signal.aborted) abort = new AbortController();
        arm(this.timeoutMs * 4);

        return abort.signal;
      });

      if (!response.body) {
        throw new AtlassianRequestError(
          `Byte download for ${path} returned no body`,
          response.status,
        );
      }

      let size = 0;
      const counter = new Transform({
        transform: (chunk: Buffer, _enc, cb) => {
          size += chunk.length;

          if (size > maxBytes) {
            cb(
              new AtlassianRequestError(
                `Attachment ${path} is ${size}+ bytes (> ${maxBytes} cap)`,
                413,
              ),
            );

            return;
          }

          arm(this.timeoutMs);
          cb(null, chunk);
        },
      });

      arm(this.timeoutMs);
      await pipeline(
        Readable.fromWeb(response.body as WebReadableStream),
        counter,
        createWriteStream(destFilePath),
      );

      return { contentType: response.headers.get('content-type'), size };
    } catch (err) {
      await unlink(destFilePath).catch(() => undefined);
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
      abort.abort();
    }
  }

  /**
   * Shared header phase of a byte download: auth, manual redirect chain, ok-check, and the
   * declared-length pre-check. Callers choose the body sink (buffer vs file stream) and supply the
   * per-hop abort signal.
   *
   * Jira Cloud serves attachment bytes via `/rest/api/3/attachment/content/{id}`, which 303s to a
   * pre-signed media URL (`api.media.atlassian.com` → often an object-store URL). Server streams
   * the bytes directly (200). We therefore follow redirects — but SAFELY: each hop's target is
   * re-validated through the same SSRF guard as the base URL, and the Atlassian Authorization
   * header is stripped the moment the origin changes, so signed cross-origin URLs never receive
   * (and cannot leak) the connection credentials. A relative Location stays same-origin and keeps
   * auth.
   */
  private async openByteResponse(
    path: string,
    maxBytes: number,
    signalFor: () => AbortSignal,
  ): Promise<Response> {
    let attempt = 0;

    while (true) {
      try {
        const response = await this.openByteResponseOnce(path, signalFor);

        if (
          (response.status === 429 || response.status >= 500) &&
          attempt < this.maxRetries
        ) {
          await response.body?.cancel().catch(() => undefined);

          const retryAfter =
            response.status === 429
              ? (this.parseRetryAfterMs(response.headers.get('retry-after')) ??
                this.backoffMs(attempt))
              : this.backoffMs(attempt);

          if (response.status === 429) {
            this.logger.warn(
              `429 from byte download ${path}; retrying after ${retryAfter}ms (attempt ${attempt + 1})`,
            );
          }

          await this.sleep(retryAfter);
          attempt++;
          continue;
        }

        if (!response.ok) {
          throw new AtlassianRequestError(
            `Byte download for ${path} failed with ${response.status}`,
            response.status,
          );
        }

        const declared = Number(response.headers.get('content-length') ?? '');

        if (Number.isFinite(declared) && declared > maxBytes) {
          throw new AtlassianRequestError(
            `Attachment ${path} is ${declared} bytes (> ${maxBytes} cap)`,
            413,
          );
        }

        return response;
      } catch (err) {
        if (
          err instanceof ByteDownloadNetworkError &&
          err.retryable &&
          attempt < this.maxRetries
        ) {
          await this.sleep(this.backoffMs(attempt));
          attempt++;
          continue;
        }

        throw err;
      }
    }
  }

  private async openByteResponseOnce(
    path: string,
    signalFor: () => AbortSignal,
  ): Promise<Response> {
    // Full origin, not hostname: an https→http or port-changing redirect is a DIFFERENT origin and
    // must not receive the connection credentials, same as a host change.
    const baseOrigin = new URL(this.origin).origin;
    const authHeaders: Record<string, string> = { 'User-Agent': USER_AGENT };

    await this.auth.apply(authHeaders);

    let currentUrl = this.origin + this.resolvePath(path);
    let headers: Record<string, string> = authHeaders;
    let response: Response;

    for (let hop = 0; ; hop++) {
      try {
        response = await fetch(currentUrl, {
          method: 'GET',
          headers,
          redirect: 'manual',
          signal: signalFor(),
        });
      } catch (err) {
        throw new ByteDownloadNetworkError(
          `Byte download failed for ${path}: ${describeFetchFailure(err)}`,
          !isTlsChainFailure(err),
        );
      }

      if (response.status < 300 || response.status >= 400) break;

      // 3xx — follow, up to the cap.
      if (hop >= MAX_BYTE_REDIRECTS) {
        throw new AtlassianRequestError(
          `Byte download for ${path} exceeded ${MAX_BYTE_REDIRECTS} redirects`,
          response.status,
        );
      }

      const location = response.headers.get('location');

      if (!location) {
        throw new AtlassianRequestError(
          `Byte download for ${path} was redirected (${response.status}) with no Location header`,
          response.status,
        );
      }

      let nextUrl: URL;

      try {
        nextUrl = new URL(location, currentUrl);
      } catch {
        throw new AtlassianRequestError(
          `Byte download for ${path} redirected to an invalid URL`,
          response.status,
        );
      }

      const sameOrigin = nextUrl.origin === baseOrigin;

      // A same-origin redirect needs no re-validation — the origin was already SSRF-checked (and its
      // IP pinned) at construction. A cross-origin hop (Cloud's media/object-store URL, but also a
      // scheme or port change on the same host) is re-validated in full, and the connection
      // credentials are stripped so they cannot leak to that origin.
      if (!sameOrigin) {
        const safety = await validateBaseUrl(nextUrl.toString(), {
          allowPrivateNetworks: this.allowPrivateNetworks,
          allowInsecureHttp: this.allowInsecureHttp,
        });

        if (!safety.ok) {
          throw new AtlassianRequestError(
            `Byte download for ${path} redirected to an unsafe target: ${safety.reason}`,
            response.status,
          );
        }
      }

      headers = sameOrigin ? authHeaders : {};
      currentUrl = nextUrl.toString();
    }

    return response;
  }

  /**
   * Probe a path without throwing on non-2xx — used for capability detection
   * (e.g. Confluence Cloud `/wiki/api/v2` presence). Returns `{ ok, status }`.
   */
  async probe(path: string): Promise<{ ok: boolean; status: number }> {
    try {
      const res = await this.request('GET', path, { retryable: false });

      return { ok: res.ok, status: res.status };
    } catch (err) {
      if (err instanceof AtlassianRequestError) {
        return { ok: false, status: err.status };
      }

      return { ok: false, status: 0 };
    }
  }

  /**
   * Core request with retry/backoff. `retryable:false` disables the retry loop (probes).
   * Returns the parsed body for 2xx AND for non-retryable non-2xx (so probes can read the status).
   */
  async request<T>(
    method: string,
    path: string,
    opts: { body?: unknown; retryable?: boolean } = {},
  ): Promise<HttpResponse<T>> {
    const url = this.origin + this.resolvePath(path);
    const retryable = opts.retryable !== false;
    let attempt = 0;

    while (true) {
      const headers: Record<string, string> = {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      };

      if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

      await this.auth.apply(headers);

      let response: Response;

      try {
        response = await fetch(url, {
          method,
          headers,
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
          // SSRF guard: never follow redirects — a malicious server could 302 to an
          // internal/metadata address, bypassing the base-URL validation.
          redirect: 'manual',
        });
      } catch (err) {
        // Network error / timeout — retry with backoff, else surface. A certificate-verification
        // failure is skipped here on purpose: Node reads NODE_EXTRA_CA_CERTS once at startup, so
        // that error is deterministic for this process and retrying only delays the message by
        // several seconds of backoff.
        if (retryable && attempt < this.maxRetries && !isTlsChainFailure(err)) {
          await this.sleep(this.backoffMs(attempt));
          attempt++;
          continue;
        }

        throw new AtlassianRequestError(
          `Network error calling ${method} ${path}: ${describeFetchFailure(err)}`,
          0,
        );
      }

      // 3xx — terminal (redirects are never followed; see the SSRF note above).
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location') ?? 'unknown';

        throw new AtlassianRequestError(
          `${method} ${path} was redirected (${response.status} → ${location}). ` +
            'Redirects are not followed for security — configure the connection with the final base URL.',
          response.status,
        );
      }

      // 429 — honor Retry-After, then retry.
      if (response.status === 429 && retryable && attempt < this.maxRetries) {
        const retryAfter =
          this.parseRetryAfterMs(response.headers.get('retry-after')) ??
          this.backoffMs(attempt);

        this.logger.warn(
          `429 from ${method} ${path}; retrying after ${retryAfter}ms (attempt ${attempt + 1})`,
        );
        await this.sleep(retryAfter);
        attempt++;
        continue;
      }

      // 5xx — retry with backoff.
      if (response.status >= 500 && retryable && attempt < this.maxRetries) {
        await this.sleep(this.backoffMs(attempt));
        attempt++;
        continue;
      }

      const parsed = await this.parseBody<T>(response);

      return { ok: response.ok, status: response.status, body: parsed };
    }
  }

  private async parseBody<T>(response: Response): Promise<T> {
    const text = await response.text();

    if (!text) return undefined as unknown as T;

    try {
      return JSON.parse(text) as T;
    } catch {
      // Some endpoints return non-JSON error bodies; expose as text under a wrapper.
      return { _raw: text } as unknown as T;
    }
  }

  /** Retry-After may be seconds or an HTTP-date. Returns ms, or null if unparseable. */
  private parseRetryAfterMs(value: string | null): number | null {
    if (!value) return null;

    const seconds = Number(value);

    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

    const date = Date.parse(value);

    if (Number.isFinite(date)) return Math.max(0, date - Date.now());

    return null;
  }

  /** Exponential backoff (2^attempt s) capped at 60s, with ±50% jitter. */
  private backoffMs(attempt: number): number {
    const base = Math.min(60_000, 2 ** attempt * 1000);

    return Math.floor(base * (0.5 + Math.random() * 0.5));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
