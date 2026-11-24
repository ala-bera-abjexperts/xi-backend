/**
 * @fileoverview DTO for updating user profile fields. All properties are optional,
 * allowing partial updates to the user's public profile.
 * @module src/users/dto/update-profile.dto
 * @author Prince Jadiya
 */

import {
  IsString,
  IsOptional,
  MinLength,
  MaxLength,
  IsDateString,
  IsIn,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Data transfer object for profile update requests.
 *
 * All fields are optional; only provided fields will be updated
 * in the `public.users` table.
 */
export class UpdateProfileDto {
  /** User's first name */
  @ApiPropertyOptional({ example: 'Prince' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  first_name?: string;

  /** User's last name */
  @ApiPropertyOptional({ example: 'Jadiya' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  last_name?: string;

  /** User's mobile phone number */
  @ApiPropertyOptional({ example: '9601910055' })
  @IsOptional()
  @IsString()
  mobile?: string;

  /** User's role or job title (display only) */
  @ApiPropertyOptional({ example: 'Full Stack Developer' })
  @IsOptional()
  @IsString()
  role?: string;

  /** User's country */
  @ApiPropertyOptional({ example: 'India' })
  @IsOptional()
  @IsString()
  country?: string;

  /** User's preferred language; must match the frontend's locales (en/de) */
  @ApiPropertyOptional({ example: 'en', enum: ['en', 'de'] })
  @IsOptional()
  @IsIn(['en', 'de'])
  language?: string;

  /** User's date of birth in ISO 8601 date format */
  @ApiPropertyOptional({ example: '2002-01-06' })
  @IsOptional()
  @IsDateString()
  date_of_birth?: string;
}
