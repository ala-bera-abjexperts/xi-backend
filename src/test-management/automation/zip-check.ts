import { fromBuffer, type Entry, type ZipFile } from 'yauzl';

import { AUTOMATION_LIMITS } from './automation-inputs';

export type ZipProblem =
  | 'NOT_A_ZIP'
  | 'TOO_MANY_ENTRIES'
  | 'TOO_LARGE_UNPACKED'
  | 'UNSAFE_PATH'
  | 'SYMLINK';

// Unix file type bits in the high word of the external attributes.
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

function unsafeName(name: string): boolean {
  return (
    name.startsWith('/') ||
    name.includes('\\') ||
    name.includes('\0') ||
    /^[A-Za-z]:/.test(name) ||
    name.split('/').includes('..')
  );
}

/**
 * Reads only the zip's table of contents (nothing is unpacked) and reports the first rule it breaks, or null.
 * Every entry counts toward the limit, folders and hidden files included.
 */
export function checkZip(buffer: Buffer): Promise<ZipProblem | null> {
  return new Promise((resolve) => {
    // validateEntrySizes stays on; lazyEntries lets us stop at the first problem.
    fromBuffer(
      buffer,
      { lazyEntries: true, decodeStrings: true, strictFileNames: true },
      (error, zip?: ZipFile) => {
        if (error || !zip) return resolve('NOT_A_ZIP');

        let entries = 0;
        let unpacked = 0;
        let done = false;

        const stop = (problem: ZipProblem | null) => {
          if (done) return;
          done = true;
          zip.close();
          resolve(problem);
        };

        zip.on('entry', (entry: Entry) => {
          entries += 1;
          unpacked += entry.uncompressedSize;

          if (entries > AUTOMATION_LIMITS.zipEntries)
            return stop('TOO_MANY_ENTRIES');
          if (unpacked > AUTOMATION_LIMITS.zipUnpackedBytes)
            return stop('TOO_LARGE_UNPACKED');
          if (unsafeName(entry.fileName)) return stop('UNSAFE_PATH');
          if (((entry.externalFileAttributes >>> 16) & S_IFMT) === S_IFLNK)
            return stop('SYMLINK');

          zip.readEntry();
        });
        zip.on('end', () => stop(null));
        // The reader itself refuses unsafe names, so those reach us as errors.
        zip.on('error', (e: Error) =>
          stop(
            /absolute path|relative path|invalid characters/.test(e.message)
              ? 'UNSAFE_PATH'
              : 'NOT_A_ZIP',
          ),
        );
        zip.readEntry();
      },
    );
  });
}
