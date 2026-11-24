/**
 * @fileoverview Data Transfer Object containing only an email field.
 * Used by endpoints that only require an email address, such as forgot-password
 * and resend-verification.
 * @module src/auth/dto/email.dto
 * @author Prince Jadiya
 */

import { IsEmail } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * DTO for endpoints that require only an email address (e.g., `POST /auth/forgot-password`,
 * `POST /auth/resend-verification`).
 *
 * Validation rules:
 * - `email`: valid email format
 */
export class EmailDto {
  /**
   * User's email address. Must be a valid email format.
   * @example 'user@example.com'
   */
  @ApiProperty({
    example: 'user@example.com',
    description: 'User email address',
  })
  @IsEmail()
  email: string;
}
