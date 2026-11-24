/**
 * @fileoverview Classifies a transport failure as retryable or terminal.
 * @module src/backup/adapters/sftp/sftp-error-taxonomy
 *
 * Without this the 2^attempt backoff cheerfully retries a rejected password five times, turning a
 * one-line fix into a twenty-minute wait. Just as importantly, a wrong passphrase must be
 * distinguishable from a wrong key and from a rejected user, or the admin re-types the wrong field.
 *
 * Nothing here ever echoes key material: classification reads the error CODE and a normalised
 * message, and the text we return is our own.
 */

/** Mirrors the error_class CHECK on backup_runs and backup_run_items. */
export type BackupErrorClass =
  | 'transient'
  | 'rate_limited'
  | 'permanent'
  | 'quota'
  | 'conflict'
  | 'config'
  | 'crypto';

export interface ClassifiedError {
  errorClass: BackupErrorClass;

  /** False means: stop now, a human has to change something. */
  retryable: boolean;

  /** Stable, greppable identifier for logs and the run ledger. */
  code: string;

  /** Text safe to show an admin. Never contains a secret or a stack trace. */
  message: string;

  /**
   * The server's own words, redacted — or undefined when it said nothing usable.
   *
   * Exists because the catch-all used to read "The transfer failed. See the run details for the
   * reported error", and the run details contained only that same sentence. An admin had no way,
   * anywhere in the product or its logs, to find out what the server actually objected to.
   */
  detail?: string;
}

interface RawError {
  code?: string | number;
  message?: string;
  level?: string;
}

/** Network-level conditions that genuinely resolve themselves on a later attempt. */
const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
]);

/**
 * Authentication and authorisation failures. Retrying these is not merely useless — repeated
 * attempts can trip an account lockout on the customer's server.
 */
const AUTH_MARKERS = [
  'all configured authentication methods failed',
  'authentication failure',
  'permission denied (publickey',
  'permission denied (password',
  'no matching authentication',
];

const PASSPHRASE_MARKERS = [
  'bad passphrase',
  'incorrect passphrase',
  'decrypt failed',
  'unable to decrypt',
  'bad decrypt',
];

const KEY_FORMAT_MARKERS = [
  'cannot parse privatekey',
  'unsupported key format',
  'malformed private key',
  'invalid key',
];

/**
 * Anything at or after one of these may be key material, so the text is cut there.
 *
 * Truncating rather than masking is deliberate: a redactor that tries to blank out the secret and
 * keep the tail has to be right every time, while one that throws the tail away only has to find
 * the START of the secret. `ssh2` puts its explanation first and the offending material after it,
 * so the half worth reading is the half that survives.
 */
const SECRET_MARKERS =
  /(-+\s*BEGIN|\bBEGIN\b|PRIVATE\s*KEY|\bssh-(?:rsa|dss|ed25519)\b|\becdsa-sha2-)/i;

/** A run this long with no spaces is a key, a hash or a token — never prose. */
const OPAQUE_TOKEN = /\b[A-Za-z0-9+/=_-]{20,}\b/g;

/** Long enough to carry a real SFTP status line, short enough not to be a stack trace. */
const MAX_DETAIL_LENGTH = 200;

/**
 * The server's message, with anything that could be a secret removed.
 *
 * Quoting the server verbatim is what makes an unrecognised failure diagnosable — "Failure",
 * "Permission denied", "No space left on device" are each a different afternoon for whoever is on
 * call. Quoting it UNFILTERED is how a private key ends up in a database column and a support
 * ticket, so both properties have to hold at once.
 *
 * @returns Redacted text, or undefined when nothing usable survives.
 */
export function redactSftpDetail(error: unknown): string | undefined {
  const raw = (error ?? {}) as RawError;
  const message = typeof raw.message === 'string' ? raw.message : '';

  if (!message) {
    return undefined;
  }

  const secretAt = message.search(SECRET_MARKERS);
  const safe = secretAt === -1 ? message : message.slice(0, secretAt);

  const cleaned = safe
    .replace(OPAQUE_TOKEN, '[redacted]')
    // Newlines would turn one log line into several and break the run-details layout.
    .replace(/\s+/g, ' ')
    .trim()
    // A trailing colon or dash reads as a truncation artefact once the tail is gone.
    .replace(/[\s:;,-]+$/, '');

  if (!cleaned) {
    return undefined;
  }

  return cleaned.length > MAX_DETAIL_LENGTH
    ? `${cleaned.slice(0, MAX_DETAIL_LENGTH).trimEnd()}…`
    : cleaned;
}

function normalise(error: unknown): { code: string; text: string } {
  const raw = (error ?? {}) as RawError;
  const code = typeof raw.code === 'string' ? raw.code : String(raw.code ?? '');
  const text = (raw.message ?? '').toLowerCase();

  return { code, text };
}

function includesAny(text: string, markers: string[]): boolean {
  return markers.some((marker) => text.includes(marker));
}

/**
 * Maps a transport error onto the run ledger's taxonomy.
 *
 * Defaults to `transient` + retryable only for recognised network codes; anything unrecognised is
 * treated as `permanent` so an unknown failure surfaces to a human instead of burning five attempts.
 */
export function classifySftpError(error: unknown): ClassifiedError {
  const { code, text } = normalise(error);

  // Carried on every branch, not just the catch-all. Even a correctly classified failure is easier
  // to act on with the server's own wording attached to the run.
  const detail = redactSftpDetail(error);

  if (TRANSIENT_CODES.has(code)) {
    return {
      errorClass: 'transient',
      retryable: true,
      code: `sftp_${code.toLowerCase()}`,
      detail,
      message: 'The backup server could not be reached. This will be retried.',
    };
  }

  // Ordered before the generic auth check: "bad passphrase" also matches an auth marker, and
  // telling an admin to fix their username when the passphrase is wrong wastes their afternoon.
  if (includesAny(text, PASSPHRASE_MARKERS)) {
    return {
      errorClass: 'config',
      retryable: false,
      code: 'sftp_bad_passphrase',
      message:
        'The private key passphrase is incorrect. Replace the credentials and enter the passphrase again.',
    };
  }

  if (includesAny(text, KEY_FORMAT_MARKERS)) {
    return {
      errorClass: 'config',
      retryable: false,
      code: 'sftp_bad_key_format',
      message:
        'The private key could not be parsed. Supply it in OpenSSH format.',
    };
  }

  if (includesAny(text, AUTH_MARKERS)) {
    return {
      errorClass: 'permanent',
      retryable: false,
      code: 'sftp_auth_rejected',
      message:
        'The backup server rejected these credentials. Check the username and replace the credentials.',
    };
  }

  if (code === 'EACCES' || text.includes('permission denied')) {
    return {
      errorClass: 'config',
      retryable: false,
      code: 'sftp_permission_denied',
      message:
        'The account cannot write to the configured remote directory. Grant write access or change the directory.',
    };
  }

  if (code === 'ENOENT' || text.includes('no such file')) {
    return {
      errorClass: 'config',
      retryable: false,
      code: 'sftp_path_missing',
      message:
        'The configured remote directory does not exist and could not be created.',
    };
  }

  if (
    code === 'ENOSPC' ||
    text.includes('quota') ||
    text.includes('no space')
  ) {
    return {
      errorClass: 'quota',
      retryable: false,
      code: 'sftp_out_of_space',
      message: 'The backup server is out of space.',
    };
  }

  // The catch-all, and the one that matters most. It used to read "See the run details for the
  // reported error" while being the ONLY thing written to the run details — an instruction that
  // pointed at itself. Whatever the server said is the entire diagnostic value of this branch, so
  // it is repeated here, redacted.
  return {
    errorClass: 'permanent',
    retryable: false,
    code: 'sftp_unknown',
    detail,
    message: detail
      ? `The transfer failed. The server reported: ${detail}`
      : 'The transfer failed and the server gave no reason.',
  };
}
