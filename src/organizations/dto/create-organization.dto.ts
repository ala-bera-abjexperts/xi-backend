/**
 * @fileoverview DTO for creating a new organization during the onboarding flow.
 * Validates the organization name, slug, and size fields.
 * @module src/organizations/dto/create-organization.dto
 * @author Prince Jadiya
 */

import { IsString, MinLength, MaxLength, Matches, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Data transfer object for the organization creation (onboarding) request.
 *
 * The slug must be a lowercase alphanumeric string with hyphens only and
 * is validated for global uniqueness at the service layer.
 */
export class CreateOrganizationDto {
  /** Display name for the organization */
  @ApiProperty({
    example: 'Acme Corp',
    description: 'Organization display name',
  })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name: string;

  /** URL-safe slug (lowercase alphanumeric + hyphens) */
  @ApiProperty({
    example: 'acme-corp',
    description: 'URL-safe slug (lowercase, hyphens allowed)',
  })
  @IsString()
  @Matches(/^[a-z0-9-]+$/, {
    message: 'slug must contain only lowercase letters, numbers, and hyphens',
  })
  slug: string;

  /** Organization size tier */
  @ApiProperty({
    example: 'medium',
    enum: ['small', 'medium', 'large', 'enterprise'],
    description: 'Organization size tier',
  })
  @IsIn(['small', 'medium', 'large', 'enterprise'])
  size: string;
}
