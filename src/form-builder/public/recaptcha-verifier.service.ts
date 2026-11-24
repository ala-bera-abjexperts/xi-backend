import { Injectable, Logger } from '@nestjs/common';

/** Google's verification endpoint. The only network call this service makes. */
const SITEVERIFY_URL = 'https://www.google.com/recaptcha/api/siteverify';

/** Hard ceiling on the round trip, so a slow Google never holds a submission open. */
const VERIFY_TIMEOUT_MS = 5_000;

/**
 * Default v3 pass mark. Google documents 0.5 as the sensible starting point: 1.0 is very likely a
 * human, 0.0 very likely a bot. Overridable per field via `recaptcha_min_score`.
 */
const DEFAULT_V3_MIN_SCORE = 0.5;

/** Google's response body, narrowed to the parts we act on. */
interface SiteverifyResponse {
  success?: boolean;
  score?: number;
  action?: string;
  hostname?: string;
  'error-codes'?: string[];
}

/** Google's widget endpoint, used to ask which render modes a site key accepts. */
const ANCHOR_URL = 'https://www.google.com/recaptcha/api2/anchor';

/**
 * What a site key can render.
 *
 * `null` means "could not tell" — Google was unreachable or answered unexpectedly. Callers treat
 * that as "no opinion" and stay quiet rather than warning about a key that is probably fine.
 */
export interface RecaptchaKeyProbe {
  supportsCheckbox: boolean | null;
  supportsInvisible: boolean | null;

  /** Whether the SECRET half is a real secret Google recognises. `null` = could not tell. */
  secretValid: boolean | null;
}

export interface RecaptchaVerifyResult {
  ok: boolean;

  /** Present for v3. */
  score?: number;

  /** Google's machine-readable reasons, for the log line only — never shown to the visitor. */
  errorCodes?: string[];

  /** Why it failed, in terms the caller can log. */
  reason?: string;
}

/**
 * Server-side reCAPTCHA verification.
 *
 * The widget's token proves nothing on its own — it is issued to the browser and must be exchanged
 * with Google, using the SECRET half of the key pair, to learn whether it was a real solve. Without
 * this exchange the widget is decoration: a bot can post any value for the field and be accepted.
 *
 * Fails CLOSED on network trouble. A form that asked for bot protection should refuse a submission
 * it could not verify rather than quietly accept it — the visitor can retry, and the alternative
 * turns a Google outage into an open door.
 */
@Injectable()
export class RecaptchaVerifierService {
  private readonly logger = new Logger(RecaptchaVerifierService.name);

  /**
   * Exchanges a widget token for a verdict.
   *
   * @param secret  the field's `recaptcha_secret_key`
   * @param token   the value the widget put in the submission
   * @param options `remoteIp` is optional and only sharpens Google's scoring; `minScore`/`version`
   *                drive the v3 threshold check.
   */
  /**
   * Asks Google which render modes a site key supports.
   *
   * A v2-Checkbox key and an Invisible/v3 key look identical — same length, same prefix — so the
   * only way to tell them apart is to try. Requesting the widget for a mode the key does not support
   * returns a short error page containing `ErrorMain`; a supported mode returns the real widget.
   * Without this, a mismatch renders as a BLANK BOX on the live form with nothing to explain it,
   * because `grecaptcha.render` does not throw for it.
   *
   * Advisory only, and fails open: this must never block an author from saving.
   */
  async probeSiteKey(
    siteKey: string,
    secretKey?: string,
    origin?: string,
  ): Promise<RecaptchaKeyProbe> {
    const keyLooksSane = /^[A-Za-z0-9_-]{20,80}$/.test(siteKey ?? '');

    // Google's widget endpoint refuses EVERY size when the caller sends no origin, so probing
    // without one reports a perfectly good key as broken. No origin ⇒ no opinion.
    const canProbeSize = keyLooksSane && !!origin;

    const [supportsCheckbox, supportsInvisible, secretValid] =
      await Promise.all([
        canProbeSize ? this.acceptsSize(siteKey, 'normal', origin) : null,
        canProbeSize ? this.acceptsSize(siteKey, 'invisible', origin) : null,
        this.checkSecret(secretKey),
      ]);

    return { supportsCheckbox, supportsInvisible, secretValid };
  }

  /**
   * Whether Google recognises the secret, without a real solve.
   *
   * `siteverify` answers `invalid-input-secret` for a bad secret and `invalid-input-response` for a
   * good secret with a junk token — so a deliberately junk token separates the two. The secret is
   * never logged and never echoed back.
   */
  private async checkSecret(secretKey?: string): Promise<boolean | null> {
    if (!secretKey || secretKey.trim().length === 0) return null;

    try {
      const response = await fetch(SITEVERIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          secret: secretKey,
          response: 'key-check',
        }),
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      });

      if (!response.ok) return null;

      const payload = (await response.json()) as SiteverifyResponse;
      const codes = payload['error-codes'] ?? [];

      if (codes.includes('invalid-input-secret')) return false;

      // Any other outcome means Google accepted the secret and only objected to the token.
      return codes.includes('invalid-input-response') ||
        payload.success === true
        ? true
        : null;
    } catch (error) {
      this.logger.warn(`secret check failed: ${String(error)}`);

      return null;
    }
  }

  /** True/false when Google answered clearly, null when it did not. */
  private async acceptsSize(
    siteKey: string,
    size: 'normal' | 'invisible',
    origin: string,
  ): Promise<boolean | null> {
    // `co` is the calling origin, base64 with '=' padding written as '.'. Google validates the key
    // against it, so this doubles as the "is this domain allowed for the key" check.
    const co = Buffer.from(origin, 'utf8')
      .toString('base64')
      .replace(/=/g, '.');
    const url = `${ANCHOR_URL}?ar=1&k=${encodeURIComponent(siteKey)}&co=${co}&hl=en&size=${size}`;

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      });

      if (!response.ok) return null;

      const body = await response.text();

      // Google renders its error anchor for a key that cannot serve this mode.
      if (body.includes('ErrorMain')) return false;

      // Sanity-check the positive case too, so an unexpected redirect or interstitial reads as
      // "unknown" rather than a false all-clear.
      return body.includes('recaptcha') ? true : null;
    } catch (error) {
      this.logger.warn(`site-key probe failed (${size}): ${String(error)}`);

      return null;
    }
  }

  async verify(
    secret: string,
    token: unknown,
    options: {
      remoteIp?: string | null;
      version?: string;
      minScore?: number;
    } = {},
  ): Promise<RecaptchaVerifyResult> {
    if (typeof token !== 'string' || token.trim().length === 0) {
      return { ok: false, reason: 'missing-token' };
    }

    const body = new URLSearchParams({ secret, response: token });

    // Google accepts the caller's IP as an extra signal. Skip anything that is not a plain address —
    // a spoofed or malformed value is worse than none.
    if (options.remoteIp && !options.remoteIp.includes(',')) {
      body.set('remoteip', options.remoteIp);
    }

    let payload: SiteverifyResponse;

    try {
      const response = await fetch(SITEVERIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      });

      if (!response.ok) {
        this.logger.warn(`siteverify returned HTTP ${response.status}`);

        return { ok: false, reason: 'verify-unavailable' };
      }

      payload = (await response.json()) as SiteverifyResponse;
    } catch (error) {
      this.logger.warn(`siteverify request failed: ${String(error)}`);

      return { ok: false, reason: 'verify-unavailable' };
    }

    if (payload.success !== true) {
      return {
        ok: false,
        reason: 'rejected',
        errorCodes: payload['error-codes'],
      };
    }

    // v2 is pass/fail; only v3 returns a score, and a v3 token that passes `success` can still be a
    // bot with a low score.
    if (options.version === 'v3') {
      const threshold = Number.isFinite(options.minScore)
        ? (options.minScore as number)
        : DEFAULT_V3_MIN_SCORE;
      const score = typeof payload.score === 'number' ? payload.score : 0;

      if (score < threshold) {
        return { ok: false, score, reason: 'low-score' };
      }

      return { ok: true, score };
    }

    return { ok: true, score: payload.score };
  }
}
