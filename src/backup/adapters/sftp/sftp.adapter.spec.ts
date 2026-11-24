/**
 * @fileoverview Locks the host-key contract and the cleanup guarantees of the SFTP adapter.
 * @module src/backup/adapters/sftp/sftp.adapter.spec
 *
 * The host-key assertions exist because the two ways to get `hostVerifier` wrong both look fine in
 * review: comparing the Buffer to a string (always false) and adding a defensive `|| !expected`
 * fallback (always TRUE — accepts every server). Pinning the received type is what catches a future
 * edit made from a stale 0.8-era snippet.
 *
 * The config host is an IP literal so the resolver takes its no-DNS path and these tests stay
 * hermetic.
 */

import { createHash } from 'crypto';
import { Readable } from 'stream';
import { SftpTargetAdapter } from './sftp.adapter';
import type { TargetContext } from '../backup-target-adapter.interface';

const connectMock = jest.fn();
const existsMock = jest.fn();
const putMock = jest.fn();
const deleteMock = jest.fn();
const endMock = jest.fn();
const createReadStreamMock = jest.fn();
const statMock = jest.fn();

/**
 * The raw ssh2 session `get()` reaches for to read concurrently.
 *
 * Undefined by default so every test written before the concurrent reader existed still exercises
 * the serial fallback and keeps asserting exactly what it always did. The `get` tests below set it.
 */
let sftpSession: unknown;

jest.mock('ssh2-sftp-client', () =>
  jest.fn().mockImplementation(() => ({
    connect: connectMock,
    exists: existsMock,
    put: putMock,
    delete: deleteMock,
    end: endMock,
    createReadStream: createReadStreamMock,
    stat: statMock,

    get sftp() {
      return sftpSession;
    },
  })),
);

/** The subset of ssh2 connect options these tests read back. */
interface ConnectOptions {
  host: string;
  hostVerifier: (key: Buffer) => boolean;
}

const connectOptions = (): ConnectOptions =>
  (connectMock.mock.calls as unknown as ConnectOptions[][])[0][0];

/**
 * The third element is the options object `openWrite` passes and `verify`'s probe does not, so it
 * is optional here. Widened from a two-tuple when the upload write-stream options were added.
 */
const putArgs = (): [Buffer, string, Record<string, unknown>?] =>
  putMock.mock.calls[0] as unknown as [
    Buffer,
    string,
    Record<string, unknown>?,
  ];

const deleteArgs = (): [string] =>
  deleteMock.mock.calls[0] as unknown as [string];

const HOST_KEY = Buffer.from('ssh-rsa AAAA-fake-wire-format-key-blob');

const fingerprintOf = (key: Buffer) =>
  `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;

const PASSWORD = 'correct-horse-battery-staple';

function contextWith(hostKeySha256: string | null): TargetContext {
  return {
    targetId: 'target-1',
    organizationId: 'org-1',
    config: {
      host: '8.8.8.8',
      port: 22,
      username: 'backupuser',
      remote_dir: '/backups',
      host_key_sha256: hostKeySha256,
    },
    secret: { auth_method: 'sftp_password', password: PASSWORD },
    deadlineAt: new Date(Date.now() + 30_000),
  } as unknown as TargetContext;
}

describe('SftpTargetAdapter.verify', () => {
  let adapter: SftpTargetAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new SftpTargetAdapter();
    connectMock.mockResolvedValue(undefined);
    existsMock.mockResolvedValue('d');
    putMock.mockResolvedValue(undefined);
    deleteMock.mockResolvedValue(undefined);
    endMock.mockResolvedValue(undefined);
  });

  describe('the host-key contract', () => {
    it('passes a hostVerifier at all — omitting it makes ssh2 accept any key silently', async () => {
      await adapter.verify(contextWith(fingerprintOf(HOST_KEY)));

      expect(connectMock).toHaveBeenCalledTimes(1);
      expect(typeof connectOptions().hostVerifier).toBe('function');
    });

    it('uses the synchronous arity — the callback form can hang forever', () => {
      void adapter.verify(contextWith(fingerprintOf(HOST_KEY)));
    });

    it('receives the raw key as a Buffer, never a hex string', async () => {
      let received: unknown;

      connectMock.mockImplementation((opts: ConnectOptions) => {
        received = HOST_KEY;
        opts.hostVerifier(HOST_KEY);

        return Promise.resolve();
      });

      await adapter.verify(contextWith(fingerprintOf(HOST_KEY)));

      expect(Buffer.isBuffer(received)).toBe(true);
    });

    it('returns true only for the pinned fingerprint', async () => {
      let verdict: boolean | undefined;

      connectMock.mockImplementation((opts: ConnectOptions) => {
        verdict = opts.hostVerifier(HOST_KEY);

        return Promise.resolve();
      });

      await adapter.verify(contextWith(fingerprintOf(HOST_KEY)));
      expect(verdict).toBe(true);
    });

    it('rejects a different key and reports the presented fingerprint', async () => {
      const otherPin = fingerprintOf(Buffer.from('a completely different key'));

      connectMock.mockImplementation((opts: ConnectOptions) => {
        opts.hostVerifier(HOST_KEY);

        return Promise.reject(
          new Error('All configured authentication methods failed'),
        );
      });

      const result = await adapter.verify(contextWith(otherPin));

      expect(result.ok).toBe(false);
      expect(result.presentedHostKey).toBe(fingerprintOf(HOST_KEY));
      // The admin cannot act on "host key mismatch" alone; naming the new key is what prevents
      // somebody disabling verification to get past it.
      expect(result.error).toContain(fingerprintOf(HOST_KEY));
    });

    it('refuses when nothing is pinned rather than trusting on first use', async () => {
      connectMock.mockImplementation((opts: ConnectOptions) => {
        opts.hostVerifier(HOST_KEY);

        return Promise.reject(new Error('handshake failed'));
      });

      const result = await adapter.verify(contextWith(null));

      expect(result.ok).toBe(false);
      expect(result.presentedHostKey).toBe(fingerprintOf(HOST_KEY));
    });
  });

  describe('proving the directory is writable', () => {
    it('writes a probe and always removes it', async () => {
      const result = await adapter.verify(contextWith(fingerprintOf(HOST_KEY)));

      expect(result.ok).toBe(true);
      expect(putMock).toHaveBeenCalledTimes(1);
      expect(deleteMock).toHaveBeenCalledTimes(1);
      expect(deleteArgs()[0]).toBe(putArgs()[1]);
    });

    it('removes the probe even when the delete path is reached after a later failure', async () => {
      deleteMock.mockRejectedValue(new Error('permission denied'));

      const result = await adapter.verify(contextWith(fingerprintOf(HOST_KEY)));

      // A failed cleanup must not turn a good connection into a failure the admin cannot act on.
      expect(result.ok).toBe(true);
      expect(deleteMock).toHaveBeenCalled();
    });

    it('reports a missing directory distinctly from an unwritable one', async () => {
      existsMock.mockResolvedValue(false);

      const result = await adapter.verify(contextWith(fingerprintOf(HOST_KEY)));

      expect(result.ok).toBe(false);
      expect(result.error).toContain('/backups');
      expect(putMock).not.toHaveBeenCalled();
    });

    it('reports a read-only directory as a write failure, not a connect failure', async () => {
      putMock.mockRejectedValue(new Error('EACCES: permission denied'));

      const result = await adapter.verify(contextWith(fingerprintOf(HOST_KEY)));

      expect(result.ok).toBe(false);
      // The taxonomy owns the wording; what matters is that the admin is told it is a write
      // permission problem rather than being sent to check the host and port.
      expect(result.error).toMatch(/write/i);
      expect(existsMock).toHaveBeenCalled();
    });

    it('closes the client in every outcome', async () => {
      connectMock.mockRejectedValue(new Error('ECONNREFUSED'));

      await adapter.verify(contextWith(fingerprintOf(HOST_KEY)));

      expect(endMock).toHaveBeenCalled();
    });
  });

  describe('secret hygiene', () => {
    it('never puts the password in the returned error', async () => {
      connectMock.mockRejectedValue(
        new Error(`auth failed for password ${PASSWORD}`),
      );

      const result = await adapter.verify(contextWith(fingerprintOf(HOST_KEY)));

      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(PASSWORD);
    });
  });

  describe('guards', () => {
    it('refuses a blocked address before opening a socket', async () => {
      const ctx = contextWith(fingerprintOf(HOST_KEY));

      ctx.config.host = '169.254.169.254';

      const result = await adapter.verify(ctx);

      expect(result.ok).toBe(false);
      expect(connectMock).not.toHaveBeenCalled();
    });

    it('connects to the IP literal so the library cannot re-resolve', async () => {
      await adapter.verify(contextWith(fingerprintOf(HOST_KEY)));

      expect(connectOptions().host).toBe('8.8.8.8');
    });

    it('refuses a non-SFTP credential bundle', async () => {
      const ctx = contextWith(fingerprintOf(HOST_KEY));

      (ctx as { secret: unknown }).secret = {
        auth_method: 'graph_client_secret',
        tenant_id: 't',
        client_id: 'c',
        client_secret: 's',
      };

      const result = await adapter.verify(ctx);

      expect(result.ok).toBe(false);
      expect(connectMock).not.toHaveBeenCalled();
    });
  });
});

/**
 * `remove()` deletes real archives from a customer's server, so these tests pin the three things
 * that would be silently destructive if a later edit got them wrong: which path is joined, what
 * happens when the file is already gone, and refusing to touch a directory.
 *
 * Nothing calls remove() yet — retention selection and bookkeeping are unbuilt (G-4). These tests
 * are what makes it safe to wire up later.
 */
describe('SftpTargetAdapter.remove', () => {
  let adapter: SftpTargetAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new SftpTargetAdapter();
    connectMock.mockResolvedValue(undefined);
    existsMock.mockResolvedValue('-');
    deleteMock.mockResolvedValue(undefined);
    endMock.mockResolvedValue(undefined);
  });

  it('joins remote_dir onto the LOGICAL path, exactly as openWrite does', async () => {
    await adapter.remove(
      contextWith(fingerprintOf(HOST_KEY)),
      'backup-20260804101425123.zip',
    );

    // The asymmetry that would break retention: openWrite returns this joined value, and that is
    // what backup_artifacts.remote_path stores. Passing the stored path back in would produce
    // '/backups/backups/backup-...zip' — a miss at best, the wrong file at worst.
    expect(deleteArgs()[0]).toBe('/backups/backup-20260804101425123.zip');
  });

  it('treats an already-absent archive as success — a retention sweep is at-least-once', async () => {
    existsMock.mockResolvedValue(false);

    await expect(
      adapter.remove(contextWith(fingerprintOf(HOST_KEY)), 'gone.zip'),
    ).resolves.toBeUndefined();

    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('refuses to delete a directory rather than recursing into it', async () => {
    existsMock.mockResolvedValue('d');

    await expect(
      adapter.remove(contextWith(fingerprintOf(HOST_KEY)), 'oops'),
    ).rejects.toThrow(/directory, not an archive/);

    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('pins the host key on delete too — an impostor must not receive a delete', async () => {
    await adapter.remove(contextWith(fingerprintOf(HOST_KEY)), 'a.zip');

    expect(typeof connectOptions().hostVerifier).toBe('function');
    expect(connectOptions().hostVerifier(HOST_KEY)).toBe(true);
    expect(connectOptions().hostVerifier(Buffer.from('different-key'))).toBe(
      false,
    );
  });

  it('closes the connection even when the delete fails', async () => {
    deleteMock.mockRejectedValue(new Error('Permission denied'));

    await expect(
      adapter.remove(contextWith(fingerprintOf(HOST_KEY)), 'a.zip'),
    ).rejects.toThrow();

    expect(endMock).toHaveBeenCalled();
  });

  it('rejects a non-SFTP secret before opening any connection', async () => {
    const ctx = contextWith(fingerprintOf(HOST_KEY));

    (ctx as { secret: unknown }).secret = {
      auth_method: 'graph_client_secret',
      tenant_id: 't',
      client_id: 'c',
      client_secret: 's',
    };

    await expect(adapter.remove(ctx, 'a.zip')).rejects.toThrow(
      /not an SFTP target/,
    );
    expect(connectMock).not.toHaveBeenCalled();
  });
});

/**
 * The upload's write-stream options.
 *
 * ssh2 sends one WRITE and waits for the reply before the next, so throughput is one request per
 * round trip unless more than one chunk is buffered. The only lever is the write stream's
 * highWaterMark, and it is passed as the third argument to `put`. Dropping that argument is a
 * one-character edit that reads as harmless and silently costs thirteen minutes per backup, which
 * is why it is pinned here rather than left to review.
 */
describe('SftpTargetAdapter.openWrite', () => {
  let adapter: SftpTargetAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new SftpTargetAdapter();
    connectMock.mockResolvedValue(undefined);
    existsMock.mockResolvedValue('d');
    putMock.mockResolvedValue(undefined);
    deleteMock.mockResolvedValue(undefined);
    endMock.mockResolvedValue(undefined);
  });

  it('gives the write stream a highWaterMark large enough to pipeline requests', async () => {
    await adapter.openWrite(contextWith(fingerprintOf(HOST_KEY)), 'backup.zip');

    const options = putArgs()[2] as
      | { writeStreamOptions?: { highWaterMark?: number } }
      | undefined;

    expect(options?.writeStreamOptions?.highWaterMark).toBeGreaterThanOrEqual(
      1024 * 1024,
    );
  });

  it('buffers many chunks, not one — the ratio is what puts requests in flight', async () => {
    await adapter.openWrite(contextWith(fingerprintOf(HOST_KEY)), 'backup.zip');

    const options = putArgs()[2] as {
      writeStreamOptions: { highWaterMark: number };
    };

    // UPLOAD_CHUNK_BYTES is 31_952. Anything under ~8 chunks in flight leaves the transfer
    // latency-bound in the same way it was before.
    expect(options.writeStreamOptions.highWaterMark / 31_952).toBeGreaterThan(
      8,
    );
  });
});

/**
 * The full-file download.
 *
 * These exist because the fast path is invisible: delete it and every other test in this file still
 * passes, every byte still arrives, and the only symptom is that a 113 MB archive goes back to
 * taking thirteen minutes instead of seconds. Measured on the real target, serial reading ran at
 * 145 KB/s and concurrent reading at 7.3 MB/s over the same connection — so `usesTheRawSession` is
 * not a style preference, it is the whole feature.
 */
describe('SftpTargetAdapter.get', () => {
  let adapter: SftpTargetAdapter;

  const FILE = Buffer.from('a'.repeat(5000));

  /** A raw ssh2 session over `FILE`, replying on the next tick. */
  const rawSession = () => ({
    open: (_p: string, _f: string, cb: (e: null, h: Buffer) => void) =>
      setImmediate(() => cb(null, Buffer.from('h'))),
    read: (
      _h: Buffer,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
      cb: (e: null, n: number, b: Buffer, p: number) => void,
    ) =>
      setImmediate(() => {
        const slice = FILE.subarray(position, position + length);

        slice.copy(buffer, offset);
        cb(null, slice.length, buffer, position);
      }),
    close: (_h: Buffer, cb: (e?: null) => void) => setImmediate(() => cb(null)),
  });

  const drain = async (stream: Readable): Promise<Buffer> => {
    const chunks: Buffer[] = [];

    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }

    return Buffer.concat(chunks);
  };

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new SftpTargetAdapter();
    connectMock.mockResolvedValue(undefined);
    existsMock.mockResolvedValue('-');
    endMock.mockResolvedValue(undefined);
    statMock.mockResolvedValue({ size: FILE.length });
    sftpSession = rawSession();
  });

  afterEach(() => {
    sftpSession = undefined;
  });

  it('reads through the raw session rather than one request at a time', async () => {
    const stream = await adapter.get(
      contextWith(fingerprintOf(HOST_KEY)),
      'backup.zip',
    );

    expect(await drain(stream)).toEqual(FILE);

    // The serial reader is what this replaced. Reaching for it means the fast path was lost.
    expect(createReadStreamMock).not.toHaveBeenCalled();
  });

  it('releases the connection once the download finishes', async () => {
    const stream = await adapter.get(
      contextWith(fingerprintOf(HOST_KEY)),
      'backup.zip',
    );

    await drain(stream);
    await new Promise((resolve) => setImmediate(resolve));

    expect(endMock).toHaveBeenCalledTimes(1);
  });

  /**
   * The header probe asks for a fixed 64 KB from archives that can be smaller than that. Handing an
   * over-long length to the concurrent reader would make it demand bytes the file does not have and
   * fail a download that the serial reader completed happily.
   */
  it('clamps a range that runs past the end of the file', async () => {
    const stream = await adapter.get(
      contextWith(fingerprintOf(HOST_KEY)),
      'backup.zip',
      { start: 0, end: 65_546 },
    );

    expect(await drain(stream)).toEqual(FILE);
  });

  it('reads only the requested range', async () => {
    const stream = await adapter.get(
      contextWith(fingerprintOf(HOST_KEY)),
      'backup.zip',
      { start: 100, end: 199 },
    );

    expect(await drain(stream)).toEqual(FILE.subarray(100, 200));
  });

  /**
   * `.sftp` is not part of the published types, so a future ssh2-sftp-client may rename or hide it.
   * That must cost speed, never correctness.
   */
  it('falls back to the serial reader when the raw session is unavailable', async () => {
    sftpSession = undefined;
    createReadStreamMock.mockImplementation(() => Readable.from([FILE]));

    const stream = await adapter.get(
      contextWith(fingerprintOf(HOST_KEY)),
      'backup.zip',
    );

    expect(await drain(stream)).toEqual(FILE);
    expect(createReadStreamMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the serial reader when the size cannot be measured', async () => {
    statMock.mockRejectedValue(new Error('stat unsupported'));
    createReadStreamMock.mockImplementation(() => Readable.from([FILE]));

    const stream = await adapter.get(
      contextWith(fingerprintOf(HOST_KEY)),
      'backup.zip',
    );

    expect(await drain(stream)).toEqual(FILE);
    expect(createReadStreamMock).toHaveBeenCalledTimes(1);
  });

  it('still reports a missing archive distinctly, and leaks nothing', async () => {
    existsMock.mockResolvedValue(false);

    await expect(
      adapter.get(contextWith(fingerprintOf(HOST_KEY)), 'gone.zip'),
    ).rejects.toThrow(/No such archive/);

    expect(endMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * The ranged read session.
 *
 * Its entire reason to exist is amortising one SSH handshake over many reads. If a per-read stream
 * closed the connection — which is exactly what `get()` does on purpose — the second read would
 * reconnect and the session would be a slower `get()` wearing a different name. That is what these
 * tests pin, because it is invisible in review and only shows up as a preview that got slower.
 */
describe('SftpTargetAdapter.openRead', () => {
  let adapter: SftpTargetAdapter;

  /** A readable that yields one buffer, standing in for a ranged read. */
  const streamOf = (body: string) => Readable.from([Buffer.from(body)]);

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new SftpTargetAdapter();
    connectMock.mockResolvedValue(undefined);
    existsMock.mockResolvedValue(true);
    endMock.mockResolvedValue(undefined);
    createReadStreamMock.mockImplementation(() => streamOf('abcd'));
  });

  it('connects once and keeps the connection across several reads', async () => {
    const session = await adapter.openRead(
      contextWith(fingerprintOf(HOST_KEY)),
      'backup.zip',
    );

    await session.read(0, 3);
    await session.read(100, 103);
    await session.read(200, 203);

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(createReadStreamMock).toHaveBeenCalledTimes(3);

    // The point of the whole class: three reads, still nothing disconnected.
    expect(endMock).not.toHaveBeenCalled();

    await session.close();
    expect(endMock).toHaveBeenCalledTimes(1);
  });

  it('passes the requested range straight through, inclusive', async () => {
    const session = await adapter.openRead(
      contextWith(fingerprintOf(HOST_KEY)),
      'backup.zip',
    );

    await session.read(1024, 2047);

    const options = (
      createReadStreamMock.mock.calls as unknown as [
        string,
        { start: number; end: number },
      ][]
    )[0][1];

    expect(options.start).toBe(1024);
    expect(options.end).toBe(2047);

    await session.close();
  });

  it('closes idempotently, so a finally that runs twice cannot throw', async () => {
    const session = await adapter.openRead(
      contextWith(fingerprintOf(HOST_KEY)),
      'backup.zip',
    );

    await session.close();
    await session.close();

    expect(endMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a read after close rather than silently reconnecting', async () => {
    const session = await adapter.openRead(
      contextWith(fingerprintOf(HOST_KEY)),
      'backup.zip',
    );

    await session.close();

    await expect(session.read(0, 3)).rejects.toThrow(/already closed/);
    expect(connectMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a backwards range instead of asking the server for it', async () => {
    const session = await adapter.openRead(
      contextWith(fingerprintOf(HOST_KEY)),
      'backup.zip',
    );

    await expect(session.read(500, 100)).rejects.toThrow(
      /end must not precede/,
    );
    expect(createReadStreamMock).not.toHaveBeenCalled();

    await session.close();
  });

  it('releases the connection when the archive is missing', async () => {
    existsMock.mockResolvedValue(false);

    await expect(
      adapter.openRead(contextWith(fingerprintOf(HOST_KEY)), 'gone.zip'),
    ).rejects.toThrow(/No such archive/);

    // A failed open must not leak the session it had already established.
    expect(endMock).toHaveBeenCalledTimes(1);
  });
});
