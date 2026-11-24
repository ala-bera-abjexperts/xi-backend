/**
 * @fileoverview Non-secret SFTP connection shape stored in backup_targets.config.
 * @module src/backup/dto/sftp-target-config.dto
 *
 * Host-key pinning is MANDATORY, not optional: without it the first connection trusts whatever key
 * answers, which defeats the point of pinning at all. The fingerprint is the base64 SHA-256 printed by
 *   ssh-keyscan -t rsa HOST | ssh-keygen -lf - -E sha256
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class SftpTargetConfigDto {
  @ApiProperty({ description: 'Hostname or IP of the SFTP server' })
  @IsString()
  @MaxLength(253)
  host!: string;

  @ApiProperty({ default: 22 })
  @IsInt()
  @Min(1)
  @Max(65535)
  port!: number;

  @ApiProperty()
  @IsString()
  @MaxLength(256)
  username!: string;

  @ApiProperty({
    description: 'Absolute remote directory the archive is written into',
  })
  @IsString()
  @MaxLength(1024)
  remote_dir!: string;

  @ApiProperty({
    description: 'Base64 SHA-256 fingerprint of the server host key',
  })
  @Matches(/^(SHA256:)?[A-Za-z0-9+/]{43}=?$/, {
    message: 'Expected a base64 SHA-256 host-key fingerprint',
  })
  host_key_sha256!: string;

  @ApiPropertyOptional({ default: 5000 })
  @IsOptional()
  @IsInt()
  @Min(1000)
  @Max(120000)
  connect_timeout_ms?: number;

  @ApiPropertyOptional({
    default: true,
    description: 'Refuse to connect on host-key mismatch',
  })
  @IsOptional()
  @IsBoolean()
  strict_host_key?: boolean;
}
