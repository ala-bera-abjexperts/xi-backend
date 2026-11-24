/**
 * @fileoverview Converts legacy Confluence .doc attachments to a derived .docx preview.
 * @module src/migration/services/legacy-word-preview.service
 */

import { Injectable } from '@nestjs/common';
import { execFile as execFileCallback } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

const execFile = promisify(execFileCallback);
const OLE_COMPOUND_FILE = Buffer.from('d0cf11e0a1b11ae1', 'hex');
const ZIP_FILE = Buffer.from('504b0304', 'hex');
const MAX_PREVIEW_BYTES = 100 * 1024 * 1024;
const CONVERSION_TIMEOUT_MS = 60_000;

export class LegacyWordPreviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LegacyWordPreviewError';
  }
}

export function isLegacyWordDocument(filename: string): boolean {
  return /\.doc$/i.test(filename.trim());
}

/** Migration-only converter. Original bytes are retained; this produces a preview derivative. */
@Injectable()
export class LegacyWordPreviewService {
  async convert(file: Buffer): Promise<Buffer> {
    if (!file.subarray(0, OLE_COMPOUND_FILE.length).equals(OLE_COMPOUND_FILE)) {
      throw new LegacyWordPreviewError('Legacy Word file has an invalid DOC signature');
    }
    if (file.length > MAX_PREVIEW_BYTES) {
      throw new LegacyWordPreviewError('Legacy Word file exceeds the preview conversion limit');
    }

    const dir = await fs.mkdtemp(join(tmpdir(), 'xisuite-doc-preview-'));
    try {
      const source = join(dir, 'source.doc');
      const output = join(dir, 'source.docx');
      await fs.writeFile(source, file, { mode: 0o600 });
      try {
        await execFile(
          'soffice',
          [
            '--headless', '--safe-mode', '--nologo', '--nodefault',
            '--nofirststartwizard', '--nolockcheck', '--convert-to',
            'docx:Office Open XML Text', '--outdir', dir, source,
          ],
          { cwd: dir, timeout: CONVERSION_TIMEOUT_MS, maxBuffer: 64 * 1024 },
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new LegacyWordPreviewError('Legacy Word preview converter is unavailable');
        }
        throw new LegacyWordPreviewError(
          `Legacy Word conversion failed: ${(error as Error).message}`,
        );
      }

      let converted: Buffer;
      try {
        converted = await fs.readFile(output);
      } catch {
        throw new LegacyWordPreviewError('Legacy Word conversion produced no DOCX preview');
      }
      if (
        converted.length === 0 ||
        converted.length > MAX_PREVIEW_BYTES ||
        !converted.subarray(0, ZIP_FILE.length).equals(ZIP_FILE)
      ) {
        throw new LegacyWordPreviewError('Legacy Word conversion produced an invalid DOCX preview');
      }
      return converted;
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
}
