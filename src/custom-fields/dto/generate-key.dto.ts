/**
 * @fileoverview DTO for `POST /custom-fields/generate-key`.
 * @module src/custom-fields/dto/generate-key.dto
 * @author Prince Jadiya
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MinLength } from 'class-validator';

/** Request body for generating a unique field key from a name. */
export class GenerateKeyDto {
  @ApiProperty({ example: 'Business Impact' })
  @IsString()
  @MinLength(1)
  name!: string;

  @ApiPropertyOptional({
    description:
      'Optional space id for scoped uniqueness. Org-level keys still shadow all spaces.',
  })
  @IsOptional()
  @IsString()
  space_id?: string | null;

  @ApiPropertyOptional({ description: 'Ignored — org comes from auth token' })
  @IsOptional()
  @IsString()
  organizationId?: string;
}
