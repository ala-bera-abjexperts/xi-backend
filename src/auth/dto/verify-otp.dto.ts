/**
 * @fileoverview Data Transfer Object for OTP email verification requests.
 * Validates the email and OTP token before confirming the user's email address.
 * @module src/auth/dto/verify-otp.dto
 * @author Prince Jadiya
 */

import { IsEmail, IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * DTO for the `POST /auth/verify-otp` endpoint.
 *
 * Validation rules:
 * - `email`: valid email format
 * - `token`: non-empty string (the 6-digit OTP code)
 */
export class VerifyOtpDto {
  /**
   * The email address that the OTP was sent to.
   * @example 'user@example.com'
   */
  @ApiProperty({ example: 'user@example.com', description: 'User email' })
  @IsEmail()
  email: string;

  /**
   * The 6-digit OTP code received via email.
   * @example '123456'
   */
  @ApiProperty({
    example: '123456',
    description: 'The 6-digit OTP received via email',
  })
  @IsString()
  @MinLength(1)
  token: string;
}
