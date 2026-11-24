/**
 * @fileoverview DTO for updating space modules (enable/disable, reorder, settings).
 * @module src/spaces/dto/update-space-modules.dto
 * @author Prince Jadiya
 */

import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Represents a single module entry within the update payload.
 */
export class SpaceModuleItemDto {
  /** Module type identifier (e.g., 'wiki', 'tasks', 'chat') */
  @ApiProperty({
    example: 'wiki',
    description: 'Module type identifier',
  })
  @IsString()
  module_type: string;

  /** Whether the module is enabled */
  @ApiPropertyOptional({
    example: true,
    description: 'Enable or disable the module',
  })
  @IsOptional()
  @IsBoolean()
  is_enabled?: boolean;

  /** Sort order for display */
  @ApiPropertyOptional({
    example: 1,
    description: 'Sort order for display',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;

  /** Module-specific settings */
  @ApiPropertyOptional({
    description: 'Module-specific settings (JSON object)',
  })
  @IsOptional()
  @IsObject()
  settings?: Record<string, unknown>;
}

/**
 * Data transfer object for updating space modules.
 */
export class UpdateSpaceModulesDto {
  /** Array of module entries to upsert */
  @ApiProperty({
    type: [SpaceModuleItemDto],
    description: 'Array of module entries to upsert',
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SpaceModuleItemDto)
  modules: SpaceModuleItemDto[];
}
