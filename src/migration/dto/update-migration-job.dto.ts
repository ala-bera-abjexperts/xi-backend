/**
 * @fileoverview DTO for updating a migration job. Explicit optional fields
 * (NOT `PartialType(CreateMigrationJobDto)`) so the immutable identity fields
 * — `connection_id`, `source_kind`, `source_ref` — cannot be patched.
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { MigrationScopeDto } from './migration-scope.dto';
import { MigrationOptionsDto } from './migration-options.dto';

export class UpdateMigrationJobDto {
  @ApiPropertyOptional({
    description: 'Human-readable job name (unique per organization)',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({
    description: 'Existing target space id (same organization)',
  })
  @IsOptional()
  @IsUUID()
  target_space_id?: string;

  @ApiPropertyOptional({ type: MigrationScopeDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => MigrationScopeDto)
  scope?: MigrationScopeDto;

  @ApiPropertyOptional({ type: MigrationOptionsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => MigrationOptionsDto)
  options?: MigrationOptionsDto;

  @ApiPropertyOptional({ enum: ['draft', 'ready'] })
  @IsOptional()
  @IsIn(['draft', 'ready'])
  status?: 'draft' | 'ready';
}
