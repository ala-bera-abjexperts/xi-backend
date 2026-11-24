/**
 * @fileoverview Create DTO for a backup target.
 * @module src/backup/dto/create-backup-target.dto
 *
 * `secret` is WRITE-ONLY: it is encrypted into the secret trio on save and never returned. Responses
 * carry `masked_secret` only.
 *
 * class-validator cannot express "exactly the config block matching target_type, and exactly the
 * secret fields matching auth_method" — the service asserts that and returns a readable 400.
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  BACKUP_AUTH_METHODS,
  BACKUP_TARGET_TYPES,
  type BackupAuthMethod,
  type BackupTargetType,
} from '../types/backup-target-secret.type';
import { BackupTargetSecretDto } from './backup-target-secret.dto';
import { SftpTargetConfigDto } from './sftp-target-config.dto';
import { SharePointTargetConfigDto } from './sharepoint-target-config.dto';

export class CreateBackupTargetDto {
  @ApiProperty({
    description: 'Human-readable target name (unique per organization)',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiProperty({ enum: BACKUP_TARGET_TYPES })
  @IsIn(BACKUP_TARGET_TYPES as unknown as string[])
  target_type!: BackupTargetType;

  @ApiProperty({ enum: BACKUP_AUTH_METHODS })
  @IsIn(BACKUP_AUTH_METHODS as unknown as string[])
  auth_method!: BackupAuthMethod;

  @ApiPropertyOptional({ type: SftpTargetConfigDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => SftpTargetConfigDto)
  sftp?: SftpTargetConfigDto;

  @ApiPropertyOptional({ type: SharePointTargetConfigDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => SharePointTargetConfigDto)
  sharepoint?: SharePointTargetConfigDto;

  @ApiProperty({
    type: BackupTargetSecretDto,
    description: 'Write-only. Encrypted at rest, never returned.',
  })
  @ValidateNested()
  @Type(() => BackupTargetSecretDto)
  secret!: BackupTargetSecretDto;
}
