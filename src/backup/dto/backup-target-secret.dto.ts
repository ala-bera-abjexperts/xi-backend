/**
 * @fileoverview Write-only credential payload for a backup target.
 * @module src/backup/dto/backup-target-secret.dto
 *
 * Every field is optional at the class-validator level because the required set depends on
 * auth_method, which class-validator cannot express across a nested object. The service asserts the
 * correct shape (BackupTargetsService.buildSecretBundle) and returns a 400 naming the missing field.
 *
 * NOTHING here is ever echoed back. The service encrypts the assembled bundle into the
 * secret_encrypted/_iv/_tag trio and responses carry `masked_secret` only.
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class BackupTargetSecretDto {
  @ApiPropertyOptional({
    description: 'SFTP password. Required when auth_method=sftp_password.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  password?: string;

  @ApiPropertyOptional({
    description:
      'OpenSSH private key. Required when auth_method=sftp_private_key or graph_certificate.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(32768)
  private_key?: string;

  @ApiPropertyOptional({
    description: 'Passphrase protecting private_key, if it has one.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  passphrase?: string;

  @ApiPropertyOptional({
    description: 'Entra tenant id. Required for both Graph auth methods.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  tenant_id?: string;

  @ApiPropertyOptional({
    description:
      'App registration client id. Required for both Graph auth methods.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  client_id?: string;

  @ApiPropertyOptional({
    description:
      'Client secret. Required when auth_method=graph_client_secret.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(2048)
  client_secret?: string;

  @ApiPropertyOptional({
    description:
      'Certificate thumbprint. Required when auth_method=graph_certificate.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  thumbprint?: string;
}
