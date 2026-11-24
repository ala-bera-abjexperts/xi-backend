/**
 * @fileoverview Request bodies for the CI servers admin API. The token is write-only.
 * @module src/ci-servers/dto/ci-server.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateCiServerDto {
  @ApiPropertyOptional({ enum: ['jenkins'], default: 'jenkins' })
  @IsOptional()
  @IsIn(['jenkins'])
  provider?: 'jenkins';

  @ApiProperty({ example: 'Company Jenkins' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiProperty({ example: 'https://jenkins.example.com' })
  @IsString()
  @MaxLength(500)
  base_url!: string;

  @ApiProperty({ example: 'ci-bot' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  username!: string;

  @ApiProperty({ description: 'Jenkins API token (never returned)' })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  api_token!: string;
}

/** Omitted fields stay as they are; no `api_token` keeps the saved one. */
export class UpdateCiServerDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  base_url?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  username?: string;

  @ApiPropertyOptional({ description: 'Jenkins API token (never returned)' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  api_token?: string;
}
