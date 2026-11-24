/**
 * @fileoverview Body for "start a backup now".
 * @module src/backup/dto/start-backup-run.dto
 *
 * This class has to exist even though every field is optional. The global ValidationPipe runs with
 * `whitelist` and `forbidNonWhitelisted` (main.ts), so a POST carrying any key the DTO does not
 * declare is a 400 — including the `{ file_format }` the dialog sends.
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsIn, IsOptional } from 'class-validator';
import {
  BACKUP_FILE_FORMATS,
  type BackupFileFormat,
} from '../engine/writers/table-writer';

export class StartBackupRunDto {
  @ApiPropertyOptional({
    enum: BACKUP_FILE_FORMATS,
    isArray: true,
    description:
      'Every format to write. The archive holds one file per table per format, so ticking sql and ' +
      'ndjson gives a dump a person can read with psql and a layer this application can restore ' +
      'from. Omit to use the scheme default.',
  })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(BACKUP_FILE_FORMATS as unknown as string[], { each: true })
  file_formats?: BackupFileFormat[];

  /**
   * Superseded by `file_formats`, still accepted.
   *
   * Anything already calling this endpoint keeps working, and `forbidNonWhitelisted` would turn a
   * removed field into a 400 rather than a quiet no-op.
   */
  @ApiPropertyOptional({
    enum: BACKUP_FILE_FORMATS,
    deprecated: true,
    description: 'Deprecated. Use file_formats.',
  })
  @IsOptional()
  @IsIn(BACKUP_FILE_FORMATS as unknown as string[])
  file_format?: BackupFileFormat;
}
