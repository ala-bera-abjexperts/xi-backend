/**
 * @fileoverview Update DTO for a backup scheme.
 * @module src/backup/dto/update-backup-scheme.dto
 *
 * No archive_passphrase field: rotating it is POST /backup/schemes/:id/passphrase, which carries its
 * own permission. Changing selection or options bumps scheme_version.
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
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
import {
  BACKUP_SCHEME_STATUSES,
  type BackupSchemeStatus,
} from './create-backup-scheme.dto';

export class UpdateBackupSchemeDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  target_id?: string;

  @ApiPropertyOptional({ type: BackupSelectionDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => BackupSelectionDto)
  selection?: BackupSelectionDto;

  @ApiPropertyOptional({ type: BackupOptionsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => BackupOptionsDto)
  options?: BackupOptionsDto;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  schedule_enabled?: boolean;

  @ApiPropertyOptional({ example: '0 2 * * *' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  cron_expression?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @IsIanaTimezone()
  timezone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  retention_count?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  retention_days?: number;

  @ApiPropertyOptional({ enum: BACKUP_SCHEME_STATUSES })
  @IsOptional()
  @IsIn(BACKUP_SCHEME_STATUSES as unknown as string[])
  status?: BackupSchemeStatus;
}
