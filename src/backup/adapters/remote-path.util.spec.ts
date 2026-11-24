/**
 * @fileoverview Path-template tests — the traversal cases are the reason this file exists.
 * @module src/backup/adapters/remote-path.util.spec
 */

import {
  assertSafeSegment,
  joinRemotePath,
  partPathFor,
  renderRemoteName,
  slugify,
} from './remote-path.util';

const AT = new Date(Date.UTC(2026, 6, 30, 2, 5, 9));

const values = {
  scheme_slug: 'Nightly Full Backup',
  run_id: 'a1b2c3',
  at: AT,
};

describe('slugify', () => {
  it('reduces to [a-z0-9-]', () => {
    expect(slugify('Nightly Full Backup')).toBe('nightly-full-backup');
    expect(slugify('../../etc/passwd')).toBe('etc-passwd');
    expect(slugify('  ')).toBe('unnamed');
  });
});

describe('renderRemoteName', () => {
  it('substitutes every whitelisted token', () => {
    const name = renderRemoteName(
      '{scheme_slug}-{yyyy}{mm}{dd}-{hhmmss}-{run_id}-{part}.zip',
      values,
    );

    expect(name).toBe('nightly-full-backup-20260730-020509-a1b2c3-000.zip');
  });

  it('renders the archive name the engine actually uses', () => {
    // backup-YYYYMMDDHHMMSSmmm.zip — most-significant first, so a directory listing sorts
    // chronologically. Milliseconds supply uniqueness in place of an id, which is sufficient
    // because only one run per organization may be in flight at a time.
    const at = new Date(Date.UTC(2026, 7, 4, 10, 14, 25, 123));
    const name = renderRemoteName('backup-{yyyy}{mm}{dd}{hhmmss}{ms}.zip', {
      scheme_slug: '',
      run_id: '',
      at,
    });

    expect(name).toBe('backup-20260804101425123.zip');
  });

  it('zero-pads milliseconds so names stay the same length and sort correctly', () => {
    const at = new Date(Date.UTC(2026, 7, 4, 10, 14, 25, 7));
    const name = renderRemoteName('backup-{yyyy}{mm}{dd}{hhmmss}{ms}.zip', {
      scheme_slug: '',
      run_id: '',
      at,
    });

    expect(name).toBe('backup-20260804101425007.zip');
  });

  it('always carries the run id, so two runs cannot collide', () => {
    const name = renderRemoteName('{scheme_slug}-{run_id}.zip', values);

    expect(name).toContain('a1b2c3');
  });

  it('rejects an unknown token instead of leaving it literal', () => {
    expect(() =>
      renderRemoteName('{scheme_slug}-{whoami}.zip', values),
    ).toThrow(/Unknown path template token/);
  });

  it('refuses a traversal smuggled in through a token value', () => {
    // The slug pass neutralises it, so the rendered name stays inside the directory.
    const name = renderRemoteName('{scheme_slug}.zip', {
      ...values,
      scheme_slug: '../../../etc/passwd',
    });

    expect(name).toBe('etc-passwd.zip');
    expect(name).not.toContain('..');
    expect(name).not.toContain('/');
  });

  it('refuses a separator baked into the template itself', () => {
    expect(() => renderRemoteName('sub/dir/{run_id}.zip', values)).toThrow(
      /path separator/,
    );
  });
});

describe('assertSafeSegment', () => {
  it.each([
    ['/etc/passwd', /relative/],
    ['C:\\windows\\system32', /relative|separator/],
    ['a/b.zip', /separator/],
    ['a\\b.zip', /separator/],
    ['..', /\.\./],
    ['back..up.zip', /\.\./],
    ['', /empty/],
  ])('rejects %s', (name, pattern) => {
    expect(() => assertSafeSegment(name)).toThrow(pattern);
  });

  it('rejects control characters', () => {
    expect(() => assertSafeSegment('back\u0000up.zip')).toThrow(/control/);
  });

  it('accepts an ordinary rendered name', () => {
    expect(() =>
      assertSafeSegment('nightly-20260730-a1b2c3.zip'),
    ).not.toThrow();
  });
});

describe('joinRemotePath / partPathFor', () => {
  it('joins without doubling the separator', () => {
    expect(joinRemotePath('/backups/', 'a.zip')).toBe('/backups/a.zip');
    expect(joinRemotePath('/backups', 'a.zip')).toBe('/backups/a.zip');
  });

  it('validates the name during the join', () => {
    expect(() => joinRemotePath('/backups', '../a.zip')).toThrow();
  });

  it('uploads to a .part sibling so a reader never sees a partial file', () => {
    expect(partPathFor('/backups/a.zip')).toBe('/backups/a.zip.part');
  });
});
