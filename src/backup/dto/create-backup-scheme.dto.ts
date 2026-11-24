/**
 * @fileoverview Create DTO for a backup scheme.
 * @module src/backup/dto/create-backup-scheme.dto
 *
 * The passphrase must arrive with the first POST: encrypt_archive defaults to true and the DB
 * requires the full passphrase trio whenever it is true, so a scheme cannot be created first and
 * encrypted later.
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { BackupOptionsDto } from './backup-options.dto';
import { BackupSelectionDto } from './backup-selection.dto';
import { IsIanaTimezone } from './is-iana-timezone.validator';

export const BACKUP_SCHEME_STATUSES = [
  'draft',
  'active',
  'paused',
  'archived',
] as const;

export type BackupSchemeStatus = (typeof BACKUP_SCHEME_STATUSES)[number];

export class CreateBackupSchemeDto {
  @ApiProperty({ description: 'Scheme name (unique per organization)' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  /** Resolved against the caller's own organization — a target from another org is a 404. */
  @ApiProperty({ description: 'Target this scheme writes to' })
  @IsUUID()
  target_id!: string;

  @ApiProperty({ type: BackupSelectionDto })
  @ValidateNested()
  @Type(() => BackupSelectionDto)
  selection!: BackupSelectionDto;

  @ApiPropertyOptional({ type: BackupOptionsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => BackupOptionsDto)
  options?: BackupOptionsDto;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  encrypt_archive?: boolean;

  /** Write-only. Encrypted at rest and never returned. Required when encrypt_archive is true. */
  @ApiPropertyOptional({ description: 'Write-only archive passphrase.' })
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(1024)
  archive_passphrase?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  schedule_enabled?: boolean;

  /** Required when schedule_enabled is true. Validated with cron-parser. */
  @ApiPropertyOptional({ example: '0 2 * * *' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  cron_expression?: string;

  @ApiPropertyOptional({
    default: 'UTC',
    description:
      "IANA timezone the cron expression is read in, e.g. 'Europe/Berlin'.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @IsIanaTimezone()
  timezone?: string;

  @ApiPropertyOptional({
    description: 'Keep this many archives. Null = unlimited.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  retention_count?: number;

  @ApiPropertyOptional({
    description: 'Keep archives this many days. Null = unlimited.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  retention_days?: number;

  @ApiPropertyOptional({ enum: BACKUP_SCHEME_STATUSES, default: 'draft' })
  @IsOptional()
  @IsIn(BACKUP_SCHEME_STATUSES as unknown as string[])
  status?: BackupSchemeStatus;
}
