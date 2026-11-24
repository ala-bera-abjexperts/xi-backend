/**
 * @fileoverview Body for POST /backup/targets/:id/secret — the ONLY way to change stored credentials.
 * @module src/backup/dto/rotate-target-secret.dto
 *
 * auth_method MAY change alongside the secret: swapping an SFTP password for a private key is one
 * user action, and backup_targets_auth_matches_type_check must still hold afterwards. When omitted,
 * the target keeps its current auth_method.
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsOptional, ValidateNested } from 'class-validator';
import {
  BACKUP_AUTH_METHODS,
  type BackupAuthMethod,
} from '../types/backup-target-secret.type';
import { BackupTargetSecretDto } from './backup-target-secret.dto';

export class RotateTargetSecretDto {
  @ApiPropertyOptional({ enum: BACKUP_AUTH_METHODS })
  @IsOptional()
  @IsIn(BACKUP_AUTH_METHODS as unknown as string[])
  auth_method?: BackupAuthMethod;

  @ApiProperty({
    type: BackupTargetSecretDto,
    description: 'Write-only. Encrypted at rest, never returned.',
  })
  @ValidateNested()
  @Type(() => BackupTargetSecretDto)
  secret!: BackupTargetSecretDto;
}
