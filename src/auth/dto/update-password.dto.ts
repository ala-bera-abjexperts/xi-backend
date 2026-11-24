/**
 * @fileoverview Data Transfer Object for password update requests.
 * Validates the new password meets minimum length requirements.
 * @module src/auth/dto/update-password.dto
 * @author Prince Jadiya
 */

import { IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * DTO for the `POST /auth/update-password` endpoint.
 *
 * Validation rules:
 * - `password`: string with minimum 6 characters
 */
export class UpdatePasswordDto {
  /**
   * The new password to set. Must be at least 6 characters long.
   * @example 'NewSecurePass456'
   */
  @ApiProperty({
    example: 'NewSecurePass456',
    description: 'New password (min 6 characters)',
    minLength: 6,
  })
  @IsString()
  @MinLength(6)
  password: string;
}
