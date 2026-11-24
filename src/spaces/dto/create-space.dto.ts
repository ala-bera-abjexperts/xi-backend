/**
 * @fileoverview DTO for creating a new space within an organization.
 * Validates name (required), optional key (2-8 uppercase), and optional metadata fields.
 * @module src/spaces/dto/create-space.dto
 * @author Prince Jadiya
 */

import {
  IsString,
  IsOptional,
  MinLength,
  MaxLength,
  Matches,
  IsObject,
  IsUUID,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Data transfer object for space creation requests.
 *
 * If `key` is not provided, it will be auto-generated from the space name.
 */
export class CreateSpaceDto {
  /** Display name for the space */
  @ApiProperty({
    example: 'Engineering',
    description: 'Space display name',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  /** Unique short key (2-8 uppercase alphanumeric characters). Auto-generated if omitted. */
  @ApiPropertyOptional({
    example: 'ENG',
    description:
      'Unique space key (2-8 uppercase letters/numbers). Auto-generated from name if not provided.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z0-9]{2,8}$/, {
    message: 'key must be 2-8 uppercase alphanumeric characters',
  })
  key?: string;

  /** Optional description of the space */
  @ApiPropertyOptional({
    example: 'Engineering team workspace',
    description: 'Space description',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  /** Icon identifier or URL */
  @ApiPropertyOptional({ description: 'Icon identifier or emoji' })
  @IsOptional()
  @IsString()
  icon?: string;

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

  /** Arbitrary settings stored as JSON */
  @ApiPropertyOptional({
    description: 'Arbitrary settings (JSON object)',
  })
  @IsOptional()
  @IsObject()
  settings?: Record<string, unknown>;

  /** UUID of a space template to apply after creation */
  @ApiPropertyOptional({
    description: 'UUID of a space_templates row to apply after space creation',
  })
  @IsOptional()
  @IsUUID()
  template_id?: string;
}
