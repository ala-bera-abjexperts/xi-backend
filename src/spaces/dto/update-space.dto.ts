/**
 * @fileoverview DTO for updating an existing space. All fields are optional.
 * @module src/spaces/dto/update-space.dto
 * @author Prince Jadiya
 */

import {
  IsString,
  IsOptional,
  MinLength,
  MaxLength,
  IsBoolean,
  IsObject,
  IsUUID,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Data transfer object for space update requests. All fields are optional.
 */
export class UpdateSpaceDto {
  /** Display name for the space */
  @ApiPropertyOptional({
    example: 'Engineering v2',
    description: 'Space display name',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  /** Optional description of the space */
  @ApiPropertyOptional({ description: 'Space description' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  /**
   * Short space key (uppercase, 2-8 alphanumeric chars). Optional. When set,
   * the service re-validates uniqueness within the org and rejects collisions.
   */
  @ApiPropertyOptional({
    example: 'ENG',
    description: 'Short URL key (2-8 alphanumeric, uppercased)',
  })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(8)
  key?: string;

  /** Icon identifier or URL */
  @ApiPropertyOptional({ description: 'Icon identifier or emoji' })
  @IsOptional()
  @IsString()
  icon?: string;

  /** Storage path for the icon */
  @ApiPropertyOptional({ description: 'Storage path for the icon' })
  @IsOptional()
  @IsString()
  icon_path?: string;

  /** Theme color for the space */
  @ApiPropertyOptional({ example: '#3B82F6', description: 'Theme color hex' })
  @IsOptional()
  @IsString()
  color?: string;

  /** Background color for the space */
  @ApiPropertyOptional({
    example: '#EFF6FF',
    description: 'Background color hex',
  })
  @IsOptional()
  @IsString()
  background_color?: string;

  /** Space category label */
  @ApiPropertyOptional({
    example: 'engineering',
    description: 'Space category',
  })
  @IsOptional()
  @IsString()
  category?: string;

  /** UUID of the space lead (user) */
  @ApiPropertyOptional({ description: 'UUID of the space lead user' })
  @IsOptional()
  @IsUUID()
  lead_id?: string;

  /** UUID of the space type */
  @ApiPropertyOptional({ description: 'UUID of the space type' })
  @IsOptional()
  @IsUUID()
  space_type_id?: string;

  /** Space ID (ignored — id comes from URL param) */
  @ApiPropertyOptional({ description: 'Space UUID (ignored, use URL param)' })
  @IsOptional()
  @IsUUID()
  id?: string;

  /** Updated by user ID (ignored — resolved from auth token) */
  @ApiPropertyOptional({
    description: 'Updated by user UUID (ignored, resolved from token)',
  })
  @IsOptional()
  @IsUUID()
  updated_by?: string;

  /** Whether the space is active */
  @ApiPropertyOptional({ description: 'Whether the space is active' })
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  /** Arbitrary settings stored as JSON */
  @ApiPropertyOptional({
    description: 'Arbitrary settings (JSON object)',
  })
  @IsOptional()
  @IsObject()
  settings?: Record<string, unknown>;
}
