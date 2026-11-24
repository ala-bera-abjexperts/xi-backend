/**
 * @fileoverview Host-key pinning for SFTP targets.
 * @module src/backup/adapters/sftp/sftp-host-key.util
 *
 * Pinning is mandatory and there is deliberately NO auto-accept — not behind a flag, not on first
 * connect. A backup target is a standing export of the whole tenant; trusting whatever key answers
 * on first use would make a one-shot MITM indistinguishable from a normal setup.
 *
 * Two fingerprints may be pinned at once so a legitimate host-key rotation does not need a support
 * ticket: pin the new key alongside the old, rotate, then drop the old one.
 */

/** Accepts `SHA256:<43 base64 chars>` with or without the prefix, and tolerates one `=` of padding. */
const FINGERPRINT_PATTERN = /^(SHA256:)?([A-Za-z0-9+/]{43})=?$/;

export type HostKeyVerdict = 'match' | 'mismatch' | 'not_pinned';

export interface HostKeyCheck {
  verdict: HostKeyVerdict;
  /** Safe to show and to log — a public key fingerprint is not a secret. */
  presented: string;
  message?: string;
}

/**
 * Strips the optional prefix and padding so `SHA256:abc=` and `abc` compare equal.
 *
 * @returns the bare base64 body, or null when the input is not a SHA-256 fingerprint at all.
 */
export function normaliseFingerprint(
  value: string | null | undefined,
): string | null {
  if (!value) {
    return null;
  }

  const match = FINGERPRINT_PATTERN.exec(value.trim());

  return match ? match[2] : null;
}

/** Canonical display form, so the UI and the error text always agree. */
export function formatFingerprint(value: string): string {
  const bare = normaliseFingerprint(value);

  return bare ? `SHA256:${bare}` : value;
}

export function isValidFingerprint(value: string | null | undefined): boolean {
  return normaliseFingerprint(value) !== null;
}

/**
 * Compares the key a server presented against the pinned set.
 *
 * `not_pinned` is returned when nothing is pinned yet. That is NOT permission to connect — the
 * caller must surface the presented fingerprint for explicit admin acceptance. Returning a distinct
 * verdict rather than `false` is what keeps "no pin yet" from being quietly collapsed into "trusted".
 */
export function checkHostKey(
  presentedFingerprint: string,
  pinned: readonly (string | null | undefined)[],
): HostKeyCheck {
  const presented = formatFingerprint(presentedFingerprint);
  const presentedBare = normaliseFingerprint(presentedFingerprint);

  const pins = pinned
    .map((pin) => normaliseFingerprint(pin))
    .filter((pin): pin is string => pin !== null);

  if (!pins.length) {
    return {
      verdict: 'not_pinned',
      presented,
      message: `This server presented host key ${presented}. Accept it explicitly to pin it before backups can run.`,
    };
  }

  if (presentedBare && pins.includes(presentedBare)) {
    return { verdict: 'match', presented };
  }

  // Name the new fingerprint: an admin cannot act on "host key mismatch" alone, and the alternative
  // is that somebody disables verification to get past it.
  return {
    verdict: 'mismatch',
    presented,
    message:
      `The backup server presented host key ${presented}, which does not match the pinned key. ` +
      'Backups are blocked until an administrator confirms the change and re-pins the key.',
  };
}

/**
 * Validates a pin set on save. Rejects malformed values early rather than at 02:00 on the first
 * scheduled run.
 */
export function assertPinnable(fingerprints: readonly string[]): string[] {
  const invalid = fingerprints.filter((value) => !isValidFingerprint(value));

  if (invalid.length) {
    throw new Error(
      `Not a base64 SHA-256 host-key fingerprint: ${invalid.join(', ')}`,
    );
  }

  if (fingerprints.length > 2) {
    throw new Error(
      'At most two host keys may be pinned at once (the current key and its replacement).',
    );
  }

  return fingerprints.map((value) => formatFingerprint(value));
}
