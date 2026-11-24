/**
 * @fileoverview Maps MailService send failures to a clear, retryable API error.
 * Synchronous flows (signup OTP, invitations) await the email because it IS the
 * point of the request — but a transport failure (unreachable relay, untrusted
 * TLS chain such as a TLS-inspecting firewall or internal-CA relay) must surface
 * as an actionable 503 with a stable code, not an opaque 500 through
 * AllExceptionsFilter.
 * @module src/mail/mail-failure.util
 * @author Prince Jadiya
 */

import {
  HttpException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';

/**
 * Rethrows a mail-send failure as `503 { code: 'email_send_failed' }`.
 *
 * The caller's created row (auth user, invitation) is intentionally KEPT:
 * retrying the same request re-issues and re-sends once SMTP is fixed (e.g. the
 * relay CA added via NODE_EXTRA_CA_CERTS / on-prem `./certs/extra-ca.pem`), so
 * nothing is left permanently stuck. Do NOT use this on anti-enumeration
 * endpoints (forgot-password, resend-verification) — those must keep returning
 * their generic success and only log.
 *
 * @param {Logger} logger - The calling controller's logger (keeps the context name)
 * @param {string} context - Short description of the send that failed
 * @param {unknown} err - The error thrown by MailService
 * @returns {never} Always throws
 */
export function rethrowEmailSendFailure(
  logger: Logger,
  context: string,
  err: unknown,
): never {
  if (err instanceof HttpException) {
    throw err;
  }
  const e = err as NodeJS.ErrnoException;
  logger.error(
    `${context}: email delivery failed (${e?.code ?? 'no-code'}): ${e?.message ?? String(err)}`,
  );
  throw new ServiceUnavailableException({
    message:
      'The email could not be sent. Please try again or contact your administrator.',
    code: 'email_send_failed',
  });
}
