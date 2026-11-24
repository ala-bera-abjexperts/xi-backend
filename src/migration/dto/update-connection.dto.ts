/**
 * @fileoverview DTO for updating a migration source connection. All fields optional; `product`
 * is immutable (create a new connection to change it). A new `secret` re-encrypts; omitting it
 * leaves the stored credential untouched.
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class UpdateConnectionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  base_url?: string;

  @ApiPropertyOptional({ enum: ['basic', 'pat', 'oauth'] })
  @IsOptional()
  @IsIn(['basic', 'pat', 'oauth'])
  auth_type?: 'basic' | 'pat' | 'oauth';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(320)
  auth_username?: string;

  @ApiPropertyOptional({
    description: 'New secret; omit to keep the existing one',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(4096)
  secret?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  allow_insecure_http?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  allow_private_networks?: boolean;
}
