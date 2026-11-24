/**
 * @fileoverview DTO for an ad-hoc connection test (before persisting a connection), so the wizard
 * can validate credentials in the Credentials step. Same fields as create, minus the name.
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

export class TestConnectionDto {
  @ApiProperty({ enum: ['jira', 'confluence'] })
  @IsIn(['jira', 'confluence'])
  product!: 'jira' | 'confluence';

  @ApiProperty()
  @IsString()
  @MaxLength(2048)
  base_url!: string;

  @ApiProperty({ enum: ['basic', 'pat', 'oauth'] })
  @IsIn(['basic', 'pat', 'oauth'])
  auth_type!: 'basic' | 'pat' | 'oauth';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(320)
  auth_username?: string;

  @ApiProperty({
    description:
      'Password / API token / PAT (not persisted for an ad-hoc test)',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(4096)
  secret!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  allow_insecure_http?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  allow_private_networks?: boolean;
}
