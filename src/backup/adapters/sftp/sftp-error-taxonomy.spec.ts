/**
 * @fileoverview Error-taxonomy tests. The retry decisions here are the ones that stop a rejected
 * password being replayed five times into an account lockout.
 * @module src/backup/adapters/sftp/sftp-error-taxonomy.spec
 */

import { classifySftpError, redactSftpDetail } from './sftp-error-taxonomy';

describe('redactSftpDetail', () => {
  // The whole reason this exists: a server that says something the taxonomy does not recognise is
  // the ONLY case where its own words are the diagnosis, and those words used to be discarded.
  it('keeps what the server actually said', () => {
    expect(redactSftpDetail({ message: 'Failure' })).toBe('Failure');
    expect(redactSftpDetail({ message: 'No space left on device' })).toBe(
      'No space left on device',
    );
  });

  it('cuts the text at anything that could be key material', () => {
    const detail = redactSftpDetail({
      message: 'cannot use key -----BEGIN OPENSSH PRIVATE KEY----- abc',
    });

    expect(detail).toBe('cannot use key');
    expect(detail).not.toContain('PRIVATE KEY');
  });

  it('masks a long opaque token even without a key header', () => {
    // A base64 blob with no BEGIN marker is still not something to copy into a database column.
    const detail = redactSftpDetail({
      message: 'rejected token AAAAB3NzaC1yc2EAAAADAQABAAABgQDZ1example',
    });

    expect(detail).toBe('rejected token [redacted]');
  });

  it('collapses newlines so one failure stays one line', () => {
    expect(redactSftpDetail({ message: 'put failed:\n  Failure\n' })).toBe(
      'put failed: Failure',
    );
  });

  it('caps the length, so a stack trace cannot become the error message', () => {
    const detail = redactSftpDetail({ message: 'x '.repeat(500) });

    expect(detail!.length).toBeLessThanOrEqual(201);
  });

  it('returns undefined when there is nothing to say', () => {
    expect(redactSftpDetail(undefined)).toBeUndefined();
    expect(redactSftpDetail({ message: '' })).toBeUndefined();
    expect(redactSftpDetail({ message: '-----BEGIN X-----' })).toBeUndefined();
  });
});

describe('classifySftpError', () => {
  it('repeats the server reason for a failure it cannot classify', () => {
    // This branch used to read "The transfer failed. See the run details for the reported error"
    // while being the only thing ever written to those run details.
    const result = classifySftpError({ message: 'Failure' });

    expect(result.code).toBe('sftp_unknown');
    expect(result.detail).toBe('Failure');
    expect(result.message).toContain('Failure');
    expect(result.message).not.toContain('See the run details');
  });

  it('says so plainly when the server gave no reason at all', () => {
    expect(classifySftpError({}).message).toBe(
      'The transfer failed and the server gave no reason.',
    );
  });

  it.each(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH'])(
    'treats %s as transient and retryable',
    (code) => {
      const result = classifySftpError({ code });

      expect(result.errorClass).toBe('transient');
      expect(result.retryable).toBe(true);
    },
  );

  it('never retries a rejected credential', () => {
    const result = classifySftpError({
      message: 'All configured authentication methods failed',
    });

    expect(result.retryable).toBe(false);
    expect(result.errorClass).toBe('permanent');
    expect(result.code).toBe('sftp_auth_rejected');
  });

  it('distinguishes a wrong passphrase from a rejected user', () => {
    const passphrase = classifySftpError({ message: 'Bad passphrase' });
    const auth = classifySftpError({ message: 'Authentication failure' });

    // Both are terminal, but they point the admin at different fields.
    expect(passphrase.code).toBe('sftp_bad_passphrase');
    expect(auth.code).toBe('sftp_auth_rejected');
    expect(passphrase.message).toMatch(/passphrase/i);
    expect(auth.message).toMatch(/username/i);
  });

  it('distinguishes an unparseable key from a wrong passphrase', () => {
    const result = classifySftpError({ message: 'Cannot parse privateKey' });

    expect(result.code).toBe('sftp_bad_key_format');
    expect(result.message).toMatch(/OpenSSH/);
  });

  it.each([
    [{ code: 'EACCES' }, 'sftp_permission_denied', 'config'],
    [{ code: 'ENOENT' }, 'sftp_path_missing', 'config'],
    [{ code: 'ENOSPC' }, 'sftp_out_of_space', 'quota'],
  ])('maps %o to %s', (error, code, errorClass) => {
    const result = classifySftpError(error);

    expect(result.code).toBe(code);
    expect(result.errorClass).toBe(errorClass);
    expect(result.retryable).toBe(false);
  });

  it('defaults an unrecognised failure to terminal rather than burning five attempts', () => {
    const result = classifySftpError({ message: 'something nobody predicted' });

    expect(result.retryable).toBe(false);
    expect(result.code).toBe('sftp_unknown');
  });

  it('survives a non-error value', () => {
    expect(() => classifySftpError(undefined)).not.toThrow();
    expect(classifySftpError(undefined).retryable).toBe(false);
  });

  it('never echoes the underlying message, which could carry key material', () => {
    const result = classifySftpError({
      message: 'auth failed for key BEGIN OPENSSH PRIVATE KEY abc123',
    });

    expect(result.message).not.toContain('abc123');
    expect(result.message).not.toContain('PRIVATE KEY');
  });
});
