import { createWriteStream } from 'fs';
import { mkdir } from 'fs/promises';
import { dirname, resolve, sep } from 'path';
import { pipeline } from 'stream/promises';

import { fromBufferPromise, type Entry, type ZipFile } from 'yauzl';

import { AUTOMATION_LIMITS } from '../test-management/automation/automation-inputs';
import {
  checkZip,
  type ZipProblem,
} from '../test-management/automation/zip-check';

// A name that collides with an earlier entry, such as a file and a folder both called "a".
const COLLISION_CODES = new Set(['EEXIST', 'ENOTDIR', 'EISDIR']);
const OWNER_EXECUTE = 0o100;

export class UnzipError extends Error {
  constructor(readonly problem: ZipProblem) {
    super(`The zip was refused: ${problem}`);
  }
}

function fileMode(entry: Entry): number {
  return (entry.externalFileAttributes >>> 16) & OWNER_EXECUTE ? 0o755 : 0o644;
}

function asUnzipError(error: unknown): unknown {
  if (error instanceof UnzipError) return error;

  const code = (error as NodeJS.ErrnoException).code;

  if (code && COLLISION_CODES.has(code)) return new UnzipError('UNSAFE_PATH');

  // A full disk or missing rights is our problem, not a bad zip.
  if (code && !code.startsWith('Z_')) return error;

  return new UnzipError('NOT_A_ZIP');
}

/**
 * Unpacks a project into an empty folder, counting real bytes because a zip can lie about its size. Links are never
 * created. A file is 0644, or 0755 when the zip gives its owner the execute bit, so ./mvnw still runs in a container
 * with another user id; no other mode bit is kept. The caller removes the folder when this throws.
 */
export async function safeUnzip(
  buffer: Buffer,
  destination: string,
  maxBytes: number = AUTOMATION_LIMITS.zipUnpackedBytes,
): Promise<void> {
  const problem = await checkZip(buffer);

  if (problem) throw new UnzipError(problem);

  const root = resolve(destination);
  let zip: ZipFile | undefined;
  let total = 0;

  try {
    zip = await fromBufferPromise(buffer, {
      lazyEntries: true,
      decodeStrings: true,
      strictFileNames: true,
      validateEntrySizes: true,
    });

    for await (const entry of zip.eachEntry()) {
      const target = resolve(root, entry.fileName);

      if (!target.startsWith(root + sep)) throw new UnzipError('UNSAFE_PATH');

      if (entry.fileName.endsWith('/')) {
        await mkdir(target, { recursive: true, mode: 0o755 });
        continue;
      }

      await mkdir(dirname(target), { recursive: true, mode: 0o755 });

      const stream = await zip.openReadStreamPromise(entry);

      await pipeline(
        stream,
        async function* (source: AsyncIterable<Buffer>) {
          for await (const chunk of source) {
            total += chunk.length;

            if (total > maxBytes) throw new UnzipError('TOO_LARGE_UNPACKED');

            yield chunk;
          }
        },
        // "wx" refuses a repeated name instead of overwriting the first file.
        createWriteStream(target, { flags: 'wx', mode: fileMode(entry) }),
      );
    }
  } catch (error) {
    throw asUnzipError(error);
  } finally {
    zip?.close();
  }
}
