/**
 * @fileoverview Locks the pipelining, the ordering, and the failure modes of the concurrent reader.
 * @module src/backup/adapters/sftp/parallel-read-stream.spec
 *
 * The whole point of this class is that more than one READ is on the wire at once, and that is
 * exactly the property a refactor deletes without any test noticing: emit the bytes serially and
 * every naive assertion about content still passes, while the transfer silently goes back to being
 * thirteen minutes long. `maxObservedInFlight` is the assertion that actually matters.
 *
 * The rest guard the things concurrency makes newly possible — replies arriving out of order, a
 * short reply that is not end-of-file, and several errors from one dead connection.
 */

import {
  ParallelSftpReadStream,
  type SftpReadSource,
} from './parallel-read-stream';

const HANDLE = Buffer.from('handle');

interface FakeOptions {
  /** Reply order. 'reverse' completes the last request first; 'async' defers every reply. */
  order?: 'immediate' | 'reverse';
  /** Return this many bytes per reply, forcing the short-read continuation. */
  shortRead?: number;
  /** Fail the Nth read (1-based). */
  failReadAt?: number;
  /** Report end-of-file at this absolute position, simulating a truncated file. */
  eofAt?: number;
  openError?: Error;
}

/**
 * A fake SFTP session over an in-memory file.
 *
 * Replies are queued rather than invoked inline so the stream really does get several requests out
 * before any of them completes — an inline fake would satisfy every other assertion here while
 * making the concurrency test meaningless.
 */
function fakeSource(content: Buffer, options: FakeOptions = {}) {
  const pending: Array<() => void> = [];
  let reads = 0;
  let inFlight = 0;
  let maxObservedInFlight = 0;
  let openCalls = 0;
  let closeCalls = 0;

  const source: SftpReadSource = {
    open: (_path, _flags, cb) => {
      openCalls += 1;

      if (options.openError) {
        setImmediate(() => cb(options.openError, HANDLE));

        return;
      }

      setImmediate(() => cb(null, HANDLE));
    },
    read: (_handle, buffer, offset, length, position, cb) => {
      reads += 1;
      inFlight += 1;
      maxObservedInFlight = Math.max(maxObservedInFlight, inFlight);

      const thisRead = reads;

      pending.push(() => {
        inFlight -= 1;

        if (options.failReadAt === thisRead) {
          cb(new Error('the connection dropped'), 0, buffer, position);

          return;
        }

        if (options.eofAt !== undefined && position >= options.eofAt) {
          cb(null, 0, buffer, position);

          return;
        }

        const want = options.shortRead
          ? Math.min(options.shortRead, length)
          : length;
        const slice = content.subarray(position, position + want);

        slice.copy(buffer, offset);
        cb(null, slice.length, buffer, position);
      });
    },
    close: (_handle, cb) => {
      closeCalls += 1;
      setImmediate(() => cb(null));
    },
  };

  /** Drains queued replies until nothing new is queued. */
  const flush = async (): Promise<void> => {
    for (let guard = 0; guard < 10_000; guard += 1) {
      await new Promise((resolve) => setImmediate(resolve));

      if (!pending.length) {
        if (!inFlight) {
          return;
        }

        continue;
      }

      const batch =
        options.order === 'reverse'
          ? pending.splice(0).reverse()
          : pending.splice(0);

      for (const reply of batch) {
        reply();
      }
    }
  };

  return {
    source,
    flush,
    stats: () => ({ reads, maxObservedInFlight, openCalls, closeCalls }),
  };
}

async function collect(stream: ParallelSftpReadStream): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }

  return Buffer.concat(chunks);
}

/** Runs the stream and the fake's reply pump together. */
async function run(
  stream: ParallelSftpReadStream,
  flush: () => Promise<void>,
): Promise<Buffer> {
  const [result] = await Promise.all([collect(stream), flush()]);

  return result;
}

function contentOf(bytes: number): Buffer {
  const buffer = Buffer.allocUnsafe(bytes);

  for (let i = 0; i < bytes; i += 1) {
    buffer[i] = i % 251;
  }

  return buffer;
}

describe('ParallelSftpReadStream', () => {
  it('returns the file byte for byte', async () => {
    const content = contentOf(10_000);
    const fake = fakeSource(content);

    const stream = new ParallelSftpReadStream({
      sftp: fake.source,
      path: '/archive.zip',
      start: 0,
      length: content.length,
      chunkSize: 1000,
      concurrency: 4,
    });

    expect(await run(stream, fake.flush)).toEqual(content);
  });

  /**
   * The reason this file exists. Without concurrency the transfer costs one round trip per chunk,
   * which is what made a 113 MB archive take thirteen minutes.
   */
  it('keeps several reads in flight at once', async () => {
    const content = contentOf(10_000);
    const fake = fakeSource(content);

    const stream = new ParallelSftpReadStream({
      sftp: fake.source,
      path: '/archive.zip',
      start: 0,
      length: content.length,
      chunkSize: 1000,
      concurrency: 8,
    });

    await run(stream, fake.flush);

    expect(fake.stats().maxObservedInFlight).toBeGreaterThan(1);
  });

  it('never exceeds the configured concurrency', async () => {
    const content = contentOf(100_000);
    const fake = fakeSource(content);

    const stream = new ParallelSftpReadStream({
      sftp: fake.source,
      path: '/archive.zip',
      start: 0,
      length: content.length,
      chunkSize: 1000,
      concurrency: 5,
    });

    await run(stream, fake.flush);

    expect(fake.stats().maxObservedInFlight).toBeLessThanOrEqual(5);
  });

  /**
   * Concurrency means replies can land in any order. Emitting them in arrival order would corrupt
   * the archive in a way no checksum catches until the very end of a long restore.
   */
  it('emits in file order even when replies arrive backwards', async () => {
    const content = contentOf(10_000);
    const fake = fakeSource(content, { order: 'reverse' });

    const stream = new ParallelSftpReadStream({
      sftp: fake.source,
      path: '/archive.zip',
      start: 0,
      length: content.length,
      chunkSize: 1000,
      concurrency: 8,
    });

    expect(await run(stream, fake.flush)).toEqual(content);
  });

  /**
   * SFTP may legally return fewer bytes than asked for without it meaning end-of-file. Treating a
   * short reply as EOF would silently truncate the archive.
   */
  it('re-requests the remainder of a short read', async () => {
    const content = contentOf(4000);
    const fake = fakeSource(content, { shortRead: 250 });

    const stream = new ParallelSftpReadStream({
      sftp: fake.source,
      path: '/archive.zip',
      start: 0,
      length: content.length,
      chunkSize: 1000,
      concurrency: 4,
    });

    expect(await run(stream, fake.flush)).toEqual(content);
    expect(fake.stats().reads).toBeGreaterThan(4);
  });

  it('reads only the requested range', async () => {
    const content = contentOf(10_000);
    const fake = fakeSource(content);

    const stream = new ParallelSftpReadStream({
      sftp: fake.source,
      path: '/archive.zip',
      start: 2500,
      length: 1500,
      chunkSize: 400,
      concurrency: 4,
    });

    expect(await run(stream, fake.flush)).toEqual(content.subarray(2500, 4000));
  });

  it('ends immediately and opens nothing for an empty range', async () => {
    const fake = fakeSource(Buffer.alloc(0));

    const stream = new ParallelSftpReadStream({
      sftp: fake.source,
      path: '/archive.zip',
      start: 0,
      length: 0,
    });

    expect(await run(stream, fake.flush)).toEqual(Buffer.alloc(0));
    expect(fake.stats().openCalls).toBe(0);
  });

  it('surfaces an open failure', async () => {
    const fake = fakeSource(contentOf(100), {
      openError: new Error('permission denied'),
    });

    const stream = new ParallelSftpReadStream({
      sftp: fake.source,
      path: '/archive.zip',
      start: 0,
      length: 100,
    });

    await expect(run(stream, fake.flush)).rejects.toThrow('permission denied');
  });

  /**
   * Several reads are outstanding, so one dead connection produces several errors. The latch is what
   * stops the second one landing on an already-destroyed stream.
   */
  it('surfaces a read failure once and releases the handle', async () => {
    const content = contentOf(10_000);
    const fake = fakeSource(content, { failReadAt: 2 });

    const stream = new ParallelSftpReadStream({
      sftp: fake.source,
      path: '/archive.zip',
      start: 0,
      length: content.length,
      chunkSize: 1000,
      concurrency: 8,
    });

    await expect(run(stream, fake.flush)).rejects.toThrow(
      'the connection dropped',
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(fake.stats().closeCalls).toBe(1);
  });

  /**
   * A zip keeps its index at the tail, so a file that ends early is not a shorter archive — it is an
   * unreadable one. Saying so beats handing back a plausible file with its end missing.
   */
  it('refuses a file that ends before its reported size', async () => {
    const content = contentOf(10_000);
    const fake = fakeSource(content, { eofAt: 4000 });

    const stream = new ParallelSftpReadStream({
      sftp: fake.source,
      path: '/archive.zip',
      start: 0,
      length: content.length,
      chunkSize: 1000,
      concurrency: 4,
    });

    await expect(run(stream, fake.flush)).rejects.toThrow(/changed or removed/);
  });

  it('closes the handle exactly once on a clean read', async () => {
    const content = contentOf(5000);
    const fake = fakeSource(content);

    const stream = new ParallelSftpReadStream({
      sftp: fake.source,
      path: '/archive.zip',
      start: 0,
      length: content.length,
      chunkSize: 1000,
      concurrency: 4,
    });

    await run(stream, fake.flush);
    await new Promise((resolve) => setImmediate(resolve));

    expect(fake.stats().closeCalls).toBe(1);
  });

  /**
   * The operator cancelling a restore, or closing the tab mid-download. The handle has to go back
   * even though nothing consumed the stream.
   */
  it('releases the handle when the consumer walks away', async () => {
    const content = contentOf(10_000);
    const fake = fakeSource(content);

    const stream = new ParallelSftpReadStream({
      sftp: fake.source,
      path: '/archive.zip',
      start: 0,
      length: content.length,
      chunkSize: 1000,
      concurrency: 4,
    });

    stream.on('error', () => undefined);
    stream.read();

    await new Promise((resolve) => setImmediate(resolve));

    stream.destroy();

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(fake.stats().closeCalls).toBe(1);
  });

  /**
   * A slow consumer must not let the reader run ahead without limit. The gate counts completed but
   * unemitted chunks as well as in-flight ones, so total memory stays at concurrency x chunkSize.
   */
  it('stops issuing reads while the consumer is not reading', async () => {
    const content = contentOf(200_000);
    const fake = fakeSource(content);

    const stream = new ParallelSftpReadStream({
      sftp: fake.source,
      path: '/archive.zip',
      start: 0,
      length: content.length,
      chunkSize: 1000,
      concurrency: 4,
    });

    stream.on('error', () => undefined);
    stream.read();

    // Let replies flow with nothing consuming the stream beyond the first pull.
    for (let i = 0; i < 40; i += 1) {
      await fake.flush();
    }

    // 200 chunks exist; without backpressure every one of them would have been requested.
    expect(fake.stats().reads).toBeLessThan(200);

    // The tight bound, DERIVED rather than hardcoded: the reader may run ahead by whatever the
    // readable buffer will hold, plus the in-flight window. Pinning a literal here silently encodes
    // the runtime's default highWaterMark — it was 16 KB when this test was written and is 64 KB on
    // current Node, which is the whole difference between ~20 reads and ~69.
    const bufferedChunks = Math.ceil(stream.readableHighWaterMark / 1000);

    expect(fake.stats().reads).toBeLessThanOrEqual(bufferedChunks + 4);

    stream.destroy();
  });
});
