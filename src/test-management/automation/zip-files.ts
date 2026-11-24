import { once } from 'events';
import type { Readable } from 'stream';

import type { Archiver } from 'archiver';
import { fromBufferPromise, type Entry, type ZipFile } from 'yauzl';

import { AUTOMATION_LIMITS } from './automation-inputs';

export interface ZipFileInfo {
  path: string;
  size: number;
}

export type ZipFileContent =
  | { content: string; not_editable: null }
  | { content: null; not_editable: 'binary' | 'too_large' };

export class ZipFileError extends Error {
  constructor(
    readonly problem: 'NOT_EDITABLE' | 'TOO_LARGE' | 'TOO_LARGE_UNPACKED',
  ) {
    super(`The zip can't be changed: ${problem}`);
  }
}

async function openZip(
  buffer: Buffer,
): Promise<{ zip: ZipFile; entries: Entry[] }> {
  try {
    const zip = await fromBufferPromise(buffer, {
      lazyEntries: true,
      decodeStrings: true,
      strictFileNames: true,
      validateEntrySizes: true,
    });
    const entries: Entry[] = [];

    for await (const entry of zip.eachEntry()) entries.push(entry);

    return { zip, entries };
  } catch {
    throw new ZipFileError('NOT_EDITABLE');
  }
}

async function openEntry(zip: ZipFile, entry: Entry): Promise<Readable> {
  if (entry.isEncrypted()) throw new ZipFileError('NOT_EDITABLE');

  try {
    return await zip.openReadStreamPromise(entry);
  } catch {
    throw new ZipFileError('NOT_EDITABLE');
  }
}

const isFolder = (name: string) => name.endsWith('/');

/** Every entry name as stored, and the files once each by name, because older zips can repeat a name. */
export async function listZipFiles(
  buffer: Buffer,
): Promise<{ names: string[]; files: ZipFileInfo[] }> {
  const { zip, entries } = await openZip(buffer);

  zip.close();

  const sizes = new Map<string, number>();

  for (const { fileName, uncompressedSize } of entries) {
    if (!isFolder(fileName) && !sizes.has(fileName)) {
      sizes.set(fileName, uncompressedSize);
    }
  }

  return {
    names: entries.map((entry) => entry.fileName),
    files: [...sizes]
      .map(([path, size]) => ({ path, size }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
}

/** One file as text, or why it can't be edited; null when the zip has no such file. */
export async function readZipFile(
  buffer: Buffer,
  path: string,
): Promise<ZipFileContent | null> {
  const { zip, entries } = await openZip(buffer);

  try {
    const entry = isFolder(path)
      ? undefined
      : entries.find((item) => item.fileName === path);

    if (!entry) return null;

    // validateEntrySizes makes the stream fail if the zip lies about this size.
    if (entry.uncompressedSize > AUTOMATION_LIMITS.fileTextBytes) {
      return { content: null, not_editable: 'too_large' };
    }

    const stream = await openEntry(zip, entry);
    const chunks: Buffer[] = [];

    try {
      for await (const chunk of stream) chunks.push(chunk as Buffer);
    } catch {
      throw new ZipFileError('NOT_EDITABLE');
    }

    const data = Buffer.concat(chunks);

    if (data.includes(0)) return { content: null, not_editable: 'binary' };

    try {
      // Fatal, because saving text with replaced characters would corrupt the file. ignoreBOM keeps a BOM in the text.
      return {
        content: new TextDecoder('utf-8', {
          fatal: true,
          ignoreBOM: true,
        }).decode(data),
        not_editable: null,
      };
    } catch {
      return { content: null, not_editable: 'binary' };
    }
  } finally {
    zip.close();
  }
}

/**
 * Whether a new name clashes with what is there. These pass checkZip but fail at unzip (a and a/b, ./a beside a), or
 * on a case-insensitive disk (A and a).
 */
export function collidesWith(path: string, names: string[]): boolean {
  const wanted = path.toLowerCase();

  return names.some((raw) => {
    const name = raw
      .toLowerCase()
      .replace(/^(\.\/)+/, '')
      .replace(/\/(\.\/)+/g, '/');
    const bare = name.replace(/\/+$/, '');

    return (
      bare === wanted ||
      bare.startsWith(`${wanted}/`) ||
      (!isFolder(name) && wanted.startsWith(`${bare}/`))
    );
  });
}

/** Zip attributes keep the Unix mode in the high word; 0 means the zip tool stored none, so archiver's default applies. */
function entryData(entry: Entry): { name: string; date: Date; mode?: number } {
  const mode = (entry.externalFileAttributes >>> 16) & 0o777;

  return {
    name: entry.fileName,
    date: entry.getLastModDate(),
    ...(mode ? { mode } : {}),
  };
}

/**
 * A new zip with one file changed: every entry named `path` goes, and `content` takes the first one's place and mode,
 * or lands at the end when the name is new. Null content removes the file, so a delete can repair repeated names or
 * drop the one encrypted file. Other entries are unpacked and packed again, one at a time.
 */
export async function rebuildZip(
  source: Buffer | null,
  path: string,
  content: Buffer | null,
  alsoRemove: readonly string[] = [],
): Promise<Buffer> {
  const opened = source ? await openZip(source) : null;
  // Further files removed in the same pass, so a bulk delete packs the zip once.
  const removed = new Set(alsoRemove);

  try {
    const unpacked = (opened?.entries ?? [])
      .filter(
        (entry) => entry.fileName !== path && !removed.has(entry.fileName),
      )
      .reduce(
        (sum, entry) => sum + entry.uncompressedSize,
        content?.length ?? 0,
      );

    if (unpacked > AUTOMATION_LIMITS.zipUnpackedBytes) {
      throw new ZipFileError('TOO_LARGE_UNPACKED');
    }

    const { ZipArchive } = await import('archiver');
    const archive: Archiver = new ZipArchive({ zlib: { level: 6 } });
    const parts: Buffer[] = [];
    let size = 0;
    let fail: (error: unknown) => void = () => undefined;

    const done = new Promise<void>((resolve, reject) => {
      fail = reject;
      archive.on('data', (chunk: Buffer) => {
        size += chunk.length;

        if (size > AUTOMATION_LIMITS.zipBytes) {
          reject(new ZipFileError('TOO_LARGE'));
        } else {
          parts.push(chunk);
        }
      });
      archive.once('end', () => resolve());
      archive.on('error', reject);
    });

    const add = async (
      data: Buffer | Readable,
      details: ReturnType<typeof entryData>,
    ) => {
      archive.append(data, details);
      await Promise.race([once(archive, 'entry'), done]);
    };

    try {
      let written = false;

      for (const entry of opened?.entries ?? []) {
        if (entry.fileName === path) {
          if (content && !written) await add(content, entryData(entry));

          written = true;
        } else if (removed.has(entry.fileName)) {
          continue;
        } else if (isFolder(entry.fileName)) {
          await add(Buffer.alloc(0), entryData(entry));
        } else if (opened) {
          const stream = await openEntry(opened.zip, entry);

          stream.once('error', () => fail(new ZipFileError('NOT_EDITABLE')));
          await add(stream, entryData(entry));
        }
      }

      if (content && !written) {
        await add(content, { name: path, date: new Date() });
      }

      await Promise.race([archive.finalize(), done]);
      await done;
    } catch (error) {
      archive.abort();

      throw error;
    }

    return Buffer.concat(parts);
  } finally {
    opened?.zip.close();
  }
}
