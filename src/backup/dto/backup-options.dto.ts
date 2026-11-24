/**
 * @fileoverview How a scheme writes its archive. All optional; the engine applies defaults.
 * @module src/backup/dto/backup-options.dto
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import {
  BACKUP_FILE_FORMATS,
  type BackupFileFormat,
} from '../engine/writers/table-writer';

export const BACKUP_COMPRESSION = ['none', 'deflate'] as const;

export type BackupCompression = (typeof BACKUP_COMPRESSION)[number];

export class BackupOptionsDto {
  @ApiPropertyOptional({
    enum: BACKUP_FILE_FORMATS,
    isArray: true,
    default: ['sql'],
    description:
      'Every format each table is written in, under data/. An archive may hold several: ticking ' +
      'sql and ndjson gives one file per table of each. Only "ndjson" and "json" can be read back ' +
      'by this application — sql, csv, tsv, xlsx and xml are portable exports, not in-app restore ' +
      'points, so an archive of those alone cannot be restored here.',
  })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(BACKUP_FILE_FORMATS as unknown as string[], { each: true })
  file_formats?: BackupFileFormat[];

  /** Superseded by `file_formats`. Still accepted so existing schemes keep working. */
  @ApiPropertyOptional({
    enum: BACKUP_FILE_FORMATS,
    deprecated: true,
    description: 'Deprecated. Use file_formats.',
  })
  @IsOptional()
  @IsIn(BACKUP_FILE_FORMATS as unknown as string[])
  file_format?: BackupFileFormat;

  @ApiPropertyOptional({ enum: BACKUP_COMPRESSION, default: 'deflate' })
  @IsOptional()
  @IsIn(BACKUP_COMPRESSION as unknown as string[])
  compression?: BackupCompression;

  @ApiPropertyOptional({ default: 5000, description: 'Rows per NDJSON chunk.' })
  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(50000)
  ndjson_chunk_rows?: number;

  @ApiPropertyOptional({
    description:
      'Split the archive into volumes above this size. Null = single volume.',
  })
  @IsOptional()
  @IsInt()
  @Min(1048576)
  volume_split_bytes?: number;

  @ApiPropertyOptional({
    default: true,
    description: 'Leave stored credentials out of the archive.',
  })
  @IsOptional()
  @IsBoolean()
  exclude_secrets?: boolean;

  @ApiPropertyOptional({
    default: true,
    description: 'Redact secret-looking values inside jsonb columns.',
  })
  @IsOptional()
  @IsBoolean()
  redact_jsonb_secrets?: boolean;

  @ApiPropertyOptional({
    description: 'Abort the run if the archive would exceed this size.',
  })
  @IsOptional()
  @IsInt()
  @Min(1048576)
  max_archive_bytes?: number;

  @ApiPropertyOptional({
    default: true,
    description: 'Re-read the uploaded archive and compare checksums.',
  })
  @IsOptional()
  @IsBoolean()
  verify_after_upload?: boolean;
}
