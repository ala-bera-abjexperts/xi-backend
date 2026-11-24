/**
 * @fileoverview Tests for the deadlines on an SFTP transfer.
 * @module src/backup/adapters/sftp/sftp-deadline.spec
 *
 * `readyTimeout` bounds the handshake and nothing else. Once a connection is up, ssh2 imposes no
 * deadline at all — so a server that accepts the socket and then stops answering left `put`, `stat`
 * and `rename` pending for ever, and the backup run sat in `verifying` with no error, holding its
 * lease, until somebody noticed.
 *
 * The danger in fixing that is over-correcting: a budget tight enough to kill a slow-but-working
 * upload trades a visible hang for silently lost backups. Both halves are asserted here.
 */

import { transferBudgetMs, withDeadline } from './sftp.adapter';

describe('withDeadline', () => {
  it('returns the value when the work finishes in time', async () => {
    await expect(
      withDeadline(Promise.resolve('done'), 1_000, 'uploading'),
    ).resolves.toBe('done');
  });

  /** The whole point: a promise that never settles must not hang the run. */
  it('rejects when the work never settles', async () => {
    await expect(
      withDeadline(new Promise(() => {}), 10, 'uploading the archive'),
    ).rejects.toThrow(/ETIMEDOUT/);
  });

  /**
   * `classifySftpError` recognises ETIMEDOUT as a transient network fault, so a timed-out run is
   * retried rather than declared permanently broken. Losing this prefix would silently turn a
   * recoverable stall into a dead run.
   */
  it('names ETIMEDOUT so the taxonomy classifies it as transient', async () => {
    await expect(
      withDeadline(new Promise(() => {}), 10, 'putting the archive in place'),
    ).rejects.toThrow(/^ETIMEDOUT/);
  });

  it('says which step ran out of time', async () => {
    await expect(
      withDeadline(new Promise(() => {}), 10, 'checking the uploaded archive'),
    ).rejects.toThrow(/checking the uploaded archive/);
  });

  it('lets a genuine failure through unchanged rather than reporting a timeout', async () => {
    await expect(
      withDeadline(
        Promise.reject(new Error('Permission denied')),
        1_000,
        'uploading',
      ),
    ).rejects.toThrow('Permission denied');
  });
});

describe('transferBudgetMs', () => {
  it('gives a small archive the floor', () => {
    expect(transferBudgetMs(36_883)).toBe(70_000);
  });

  /**
   * An unknown size must not mean an unbounded wait — that is the state this whole change exists to
   * remove — so it falls back to the floor rather than to no deadline.
   */
  it('falls back to the floor when the size is unknown', () => {
    expect(transferBudgetMs()).toBe(60_000);
    expect(transferBudgetMs(0)).toBe(60_000);
  });

  /**
   * The over-correction guard. A 1 GB archive on a slow link is a legitimate backup, and a fixed
   * budget would kill it — so the allowance grows with size.
   */
  it('gives a large archive room to finish', () => {
    const oneGigabyte = 1024 * 1024 * 1024;

    // Floor plus ten seconds a megabyte: hours, not minutes.
    expect(transferBudgetMs(oneGigabyte)).toBeGreaterThan(60 * 60 * 1000);
  });

  it('grows with size', () => {
    expect(transferBudgetMs(50 * 1024 * 1024)).toBeGreaterThan(
      transferBudgetMs(5 * 1024 * 1024),
    );
  });
});
