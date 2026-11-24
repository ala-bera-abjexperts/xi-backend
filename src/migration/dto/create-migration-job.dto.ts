/**
 * @fileoverview DTO for creating a migration job (draft). `connection_id`,
 * `source_kind` and `source_ref` are fixed at creation — the update DTO
 * deliberately omits them.
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { MigrationScopeDto } from './migration-scope.dto';
import { MigrationOptionsDto } from './migration-options.dto';

export enum SourceKind {
  JIRA_PROJECT = 'jira_project',
  CONFLUENCE_SPACE = 'confluence_space',
}

export class CreateMigrationJobDto {
  @ApiProperty({
    description: 'Human-readable job name (unique per organization)',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @ApiProperty({ description: 'Migration connection id (same organization)' })
  @IsUUID()
  connection_id!: string;

  @ApiProperty({ enum: SourceKind })
  @IsEnum(SourceKind)
  source_kind!: SourceKind;

  @ApiProperty({
    description: 'Source reference — Jira project key or Confluence space key',
  })
  @IsString()
  @Matches(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, { message: 'Invalid source_ref' })
  source_ref!: string;

  @ApiPropertyOptional({
    description:
      'Existing target space id (same organization); omitted when the migration creates a new space',
  })
  @IsOptional()
  @IsUUID()
  target_space_id?: string;

  @ApiProperty({ type: MigrationScopeDto })
  @ValidateNested()
  @Type(() => MigrationScopeDto)
  scope!: MigrationScopeDto;

  @ApiProperty({ type: MigrationOptionsDto })
  @ValidateNested()
  @Type(() => MigrationOptionsDto)
  options!: MigrationOptionsDto;
}
