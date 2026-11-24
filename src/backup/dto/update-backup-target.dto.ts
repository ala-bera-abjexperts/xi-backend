/**
 * @fileoverview Update DTO for a backup target.
 * @module src/backup/dto/update-backup-target.dto
 *
 * There is DELIBERATELY no `secret` field here. The stored credential can only be replaced through
 * POST /backup/targets/:id/secret, which carries its own permission (can_manage_backup_credentials)
 * and its own audit row.
 *
 * An `@IsOptional() secret` would let a half-filled edit form overwrite a working credential with an
 * empty string. Because the global ValidationPipe runs whitelist:true, a client that sends `secret`
 * anyway has the key stripped before the service ever sees it — the omission is enforced, not merely
 * documented.
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { SftpTargetConfigDto } from './sftp-target-config.dto';
import { SharePointTargetConfigDto } from './sharepoint-target-config.dto';

export class UpdateBackupTargetDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({
    description: 'Disable a target without deleting it or its credentials.',
  })
  @IsOptional()
  @IsBoolean()
  is_enabled?: boolean;

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
}
