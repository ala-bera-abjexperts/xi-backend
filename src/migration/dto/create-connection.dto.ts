/**
 * @fileoverview DTO for creating a migration source connection. The `secret` is write-only —
 * it is encrypted on save and never returned (responses carry a `masked_secret` instead).
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateConnectionDto {
  @ApiProperty({
    description: 'Human-readable connection name (unique per organization)',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiProperty({ enum: ['jira', 'confluence'] })
  @IsIn(['jira', 'confluence'])
  product!: 'jira' | 'confluence';

  @ApiProperty({
    description:
      'Base URL of the Jira/Confluence instance, e.g. https://acme.atlassian.net or http://host:8080',
  })
  @IsString()
  @MaxLength(2048)
  base_url!: string;

  @ApiProperty({ enum: ['basic', 'pat', 'oauth'] })
  @IsIn(['basic', 'pat', 'oauth'])
  auth_type!: 'basic' | 'pat' | 'oauth';

  @ApiPropertyOptional({
    description: 'Username (Server) or email (Cloud) — required for basic auth',
  })
  @IsOptional()
  @IsString()
  @MaxLength(320)
  auth_username?: string;

  @ApiProperty({
    description:
      'Password / API token / PAT. Write-only — encrypted at rest, never returned.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(4096)
  secret!: string;

  @ApiPropertyOptional({
    description: 'Allow plain HTTP (on-prem boxes without TLS)',
  })
  @IsOptional()
  @IsBoolean()
  allow_insecure_http?: boolean;

  @ApiPropertyOptional({
    description:
      'Allow private/internal network targets (on-prem installs only)',
  })
  @IsOptional()
  @IsBoolean()
  allow_private_networks?: boolean;
}
