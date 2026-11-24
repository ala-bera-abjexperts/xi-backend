/**
 * @fileoverview Tests for the upload-limit tiers.
 *
 * `IS_ON_PREMISE` is resolved ONCE at module load, so the on-premise branch cannot be exercised by
 * mutating `process.env` after the fact — each case re-imports the module inside `jest.isolateModules`
 * with the env var already set.
 */

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

function loadWith(onPrem: string | undefined, maxBytes?: string) {
  let mod!: typeof import('./upload-limits');
  const previous = process.env.IS_ON_PREMISE;
  const previousMax = process.env.ON_PREM_MAX_UPLOAD_BYTES;

  if (onPrem === undefined) delete process.env.IS_ON_PREMISE;
  else process.env.IS_ON_PREMISE = onPrem;

  if (maxBytes === undefined) delete process.env.ON_PREM_MAX_UPLOAD_BYTES;
  else process.env.ON_PREM_MAX_UPLOAD_BYTES = maxBytes;

  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('./upload-limits') as typeof import('./upload-limits');
  });

  if (previous === undefined) delete process.env.IS_ON_PREMISE;
  else process.env.IS_ON_PREMISE = previous;

  if (previousMax === undefined) delete process.env.ON_PREM_MAX_UPLOAD_BYTES;
  else process.env.ON_PREM_MAX_UPLOAD_BYTES = previousMax;

  return mod;
}

describe('upload-limits', () => {
  describe('cloud deployment', () => {
    const m = loadWith(undefined);

    it('uses the tiered cloud caps', () => {
      expect(m.UPLOAD_LIMITS.SMALL_IMAGE).toBe(10 * MB);
      expect(m.UPLOAD_LIMITS.CONTENT_IMAGE).toBe(25 * MB);
      // Jira Cloud's default per-file attachment size, matched for migration parity (XE-T485).
      expect(m.UPLOAD_LIMITS.ATTACHMENT).toBe(1 * GB);
      expect(m.UPLOAD_LIMITS.VIDEO).toBe(2 * GB);
      expect(m.UPLOAD_LIMITS.IMPORT).toBe(25 * MB);
    });

    it('caps File Explorer at 5 GB', () => {
      expect(m.FILE_EXPLORER_MAX_BYTES).toBe(5 * GB);
    });
  });

  describe('on-premise deployment', () => {
    const m = loadWith('true');

    it('lifts every tier to at least 5 GB', () => {
      for (const [tier, bytes] of Object.entries(m.UPLOAD_LIMITS)) {
        expect({ tier, ok: bytes >= 5 * GB }).toEqual({ tier, ok: true });
      }
    });

    // Regression: `maxUploadBytes` used to return ON_PREM_MAX_BYTES unconditionally, which DOWNGRADED
    // any tier already above the floor. Site Studio video silently dropped 2 GB -> 1 GiB on-premise.
    it('never lowers a cloud cap that already exceeds the on-premise floor', () => {
      expect(m.maxUploadBytes(6 * GB)).toBe(6 * GB);
    });

    it('imposes no File Explorer ceiling', () => {
      expect(m.FILE_EXPLORER_MAX_BYTES).toBeNull();
    });

    it('honours the ON_PREM_MAX_UPLOAD_BYTES override', () => {
      const custom = loadWith('true', String(10 * GB));

      expect(custom.UPLOAD_LIMITS.ATTACHMENT).toBe(10 * GB);
      expect(custom.maxUploadBytes(1 * MB)).toBe(10 * GB);
    });

    it('falls back to 5 GB when the override is garbage', () => {
      for (const bad of ['banana', '-1', '0', '']) {
        expect(loadWith('true', bad).UPLOAD_LIMITS.ATTACHMENT).toBe(5 * GB);
      }
    });

    // multer 2.5+ throws at boot on a non-integer `limits.fileSize`.
    it('floors a fractional override to whole bytes', () => {
      const custom = loadWith('true', String(10 * GB + 0.5));

      expect(custom.UPLOAD_LIMITS.ATTACHMENT).toBe(10 * GB);
      expect(Number.isInteger(custom.maxUploadBytes(1 * MB))).toBe(true);
    });

    it('ignores the override on cloud', () => {
      expect(
        loadWith(undefined, String(10 * GB)).UPLOAD_LIMITS.ATTACHMENT,
      ).toBe(1 * GB);
    });
  });

  describe('formatMaxUpload', () => {
    const m = loadWith(undefined);

    it.each([
      [10 * MB, '10 MB'],
      [250 * MB, '250 MB'],
      [1 * GB, '1 GB'],
      [2 * GB, '2 GB'],
      [5 * GB, '5 GB'],
    ])('renders %i as %s', (bytes, expected) => {
      expect(m.formatMaxUpload(bytes)).toBe(expected);
    });
  });
});
