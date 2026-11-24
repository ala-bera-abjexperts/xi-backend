/**
 * @fileoverview Host-key pinning tests — including the ones that assert auto-accept is impossible.
 * @module src/backup/adapters/sftp/sftp-host-key.util.spec
 */

import {
  assertPinnable,
  checkHostKey,
  formatFingerprint,
  isValidFingerprint,
  normaliseFingerprint,
} from './sftp-host-key.util';

const KEY_A = 'A'.repeat(43);
const KEY_B = 'B'.repeat(43);

describe('host key fingerprints', () => {
  it('treats prefixed, bare and padded forms as the same key', () => {
    expect(normaliseFingerprint(`SHA256:${KEY_A}`)).toBe(KEY_A);
    expect(normaliseFingerprint(KEY_A)).toBe(KEY_A);
    expect(normaliseFingerprint(`SHA256:${KEY_A}=`)).toBe(KEY_A);
    expect(normaliseFingerprint('  ' + KEY_A + '  ')).toBe(KEY_A);
  });

  it('rejects anything that is not a SHA-256 fingerprint', () => {
    expect(normaliseFingerprint('MD5:aa:bb:cc')).toBeNull();
    expect(normaliseFingerprint('too-short')).toBeNull();
    expect(normaliseFingerprint('')).toBeNull();
    expect(normaliseFingerprint(null)).toBeNull();
    expect(isValidFingerprint('nope')).toBe(false);
  });

  it('renders one canonical display form', () => {
    expect(formatFingerprint(KEY_A)).toBe(`SHA256:${KEY_A}`);
    expect(formatFingerprint(`SHA256:${KEY_A}`)).toBe(`SHA256:${KEY_A}`);
  });
});

describe('checkHostKey', () => {
  it('matches a pinned key regardless of the form it was pinned in', () => {
    expect(checkHostKey(KEY_A, [`SHA256:${KEY_A}`]).verdict).toBe('match');
    expect(checkHostKey(`SHA256:${KEY_A}`, [KEY_A]).verdict).toBe('match');
  });

  it('supports two pinned keys so a rotation window works', () => {
    expect(checkHostKey(KEY_B, [KEY_A, KEY_B]).verdict).toBe('match');
  });

  it('reports a mismatch and NAMES the presented key so an admin can act', () => {
    const result = checkHostKey(KEY_B, [KEY_A]);

    expect(result.verdict).toBe('mismatch');
    expect(result.presented).toBe(`SHA256:${KEY_B}`);
    expect(result.message).toContain(KEY_B);
  });

  it('never silently trusts an unpinned key', () => {
    const result = checkHostKey(KEY_A, []);

    // The distinct verdict is the point: "nothing pinned" must not collapse into "trusted".
    expect(result.verdict).toBe('not_pinned');
    expect(result.verdict).not.toBe('match');
    expect(result.message).toContain('Accept it explicitly');
  });

  it('ignores malformed pins rather than treating them as a wildcard', () => {
    const result = checkHostKey(KEY_A, ['garbage', null, undefined]);

    expect(result.verdict).toBe('not_pinned');
  });
});

describe('assertPinnable', () => {
  it('accepts one or two well-formed fingerprints', () => {
    expect(assertPinnable([KEY_A])).toEqual([`SHA256:${KEY_A}`]);
    expect(assertPinnable([KEY_A, KEY_B])).toHaveLength(2);
  });

  it('rejects malformed input at save time', () => {
    expect(() => assertPinnable(['nope'])).toThrow(/fingerprint/);
  });

  it('refuses more than two pins', () => {
    expect(() => assertPinnable([KEY_A, KEY_B, KEY_A])).toThrow(/At most two/);
  });
});
