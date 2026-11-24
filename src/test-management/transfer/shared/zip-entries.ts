import { HttpException } from '@nestjs/common';
import { fromBufferPromise, type ZipFile } from 'yauzl';

import { fileError } from './transfer-helpers';

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

export interface ZipEntry {
  name: string;
  data: Buffer;
}

export interface ZipReadOptions {
  maxEntries: number;
  maxBytes: number;
  accept: (name: string) => boolean;
}

// An empty ZIP holds only its end record, which starts differently.
const EMPTY_ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

export const isZip = (buffer: Buffer): boolean => {
  const head = buffer.subarray(0, 4);

  return head.equals(ZIP_MAGIC) || head.equals(EMPTY_ZIP_MAGIC);
};

// Folders, macOS resource forks and hidden files are never content.
const isJunk = (name: string): boolean =>
  name.endsWith('/') ||
  name.startsWith('__MACOSX/') ||
  name.startsWith('.') ||
  name.includes('/._');

/** Reads the accepted files of a ZIP; counts and unpacked bytes are checked while inflating. */
export async function readZipEntries(
  buffer: Buffer,
  options: ZipReadOptions,
): Promise<{ entries: ZipEntry[]; skipped: string[] }> {
  let zip: ZipFile;

  try {
    zip = await fromBufferPromise(buffer, {
      lazyEntries: true,
      validateEntrySizes: true,
    });
  } catch {
    throw fileError(
      'The file is not a valid ZIP archive',
      undefined,
      'ZIP_INVALID',
    );
  }

  const entries: ZipEntry[] = [];
  const skipped: string[] = [];
  let total = 0;

  try {
    for await (const entry of zip.eachEntry()) {
      const name = entry.fileName.normalize('NFC');

      if (isJunk(name)) continue;
      if (!options.accept(name)) {
        skipped.push(name);
        continue;
      }

      if (entries.length >= options.maxEntries) {
        throw fileError(
          `The ZIP file has more than ${options.maxEntries} files`,
          undefined,
          'ZIP_TOO_MANY_FILES',
        );
      }

      // The declared size is a cheap first check; the stream count below is the real one.
      if (total + entry.uncompressedSize > options.maxBytes) {
        throw fileError(
          'The ZIP file is too large when unpacked',
          undefined,
          'ZIP_TOO_LARGE',
        );
      }

      const stream = await zip.openReadStreamPromise(entry);
      const chunks: Buffer[] = [];

      for await (const chunk of stream) {
        total += (chunk as Buffer).length;

        if (total > options.maxBytes) {
          stream.destroy();
          throw fileError(
            'The ZIP file is too large when unpacked',
            undefined,
            'ZIP_TOO_LARGE',
          );
        }

        chunks.push(chunk as Buffer);
      }

      entries.push({ name, data: Buffer.concat(chunks) });
    }
  } catch (error) {
    if (error instanceof HttpException) throw error;

    throw fileError(
      'The file is not a valid ZIP archive',
      undefined,
      'ZIP_INVALID',
    );
  } finally {
    zip.close();
  }

  return { entries, skipped };
}
