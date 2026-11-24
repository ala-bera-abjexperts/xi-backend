/**
 * @fileoverview ZIP streaming for public File Explorer folder downloads.
 * The service owns archive creation; callers own authorization and response headers.
 * @module src/file-explorer/file-explorer-archive.service
 */

import { Injectable } from '@nestjs/common';
import type { Writable } from 'stream';
import type { Archiver } from 'archiver';
import { FileExplorerStorageService } from './file-explorer-storage.service';
import type { IFeZipEntry } from './interfaces/public-download.interface';

@Injectable()
export class FileExplorerArchiveService {
  constructor(private readonly storage: FileExplorerStorageService) {}

  /**
   * Stream entries into a ZIP archive written to the provided response stream.
   *
   * Files are downloaded one-by-one so memory usage is bounded by the largest
   * individual file plus archiver's own buffers. Folder-wide count/byte caps
   * are enforced before this method is called.
   */
  async streamZip(entries: IFeZipEntry[], output: Writable): Promise<void> {
    const { ZipArchive } = await import('archiver');
    const archive: Archiver = new ZipArchive({
      zlib: { level: 6 },
    });

    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;

        if (err) {
          archive.destroy();
          reject(err);

          return;
        }

        resolve();
      };

      archive.once('error', settle);
      output.once('error', settle);
      output.once('finish', () => settle());
      archive.pipe(output);

      void (async () => {
        for (const entry of entries) {
          const buffer = await this.storage.downloadBuffer(entry.storagePath);

          archive.append(buffer, { name: entry.archivePath });
        }

        await archive.finalize();
      })().catch((err: unknown) => {
        settle(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }
}
