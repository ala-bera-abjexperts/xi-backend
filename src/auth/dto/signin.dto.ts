/**
 * @fileoverview Data Transfer Object for user sign-in requests.
 * Validates email and password before authenticating against Supabase Auth.
 * @module src/auth/dto/signin.dto
 * @author Prince Jadiya
 */

import { IsEmail, IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * DTO for the `POST /auth/signin` endpoint.
 *
 * Validation rules:
 * - `email`: valid email format
 * - `password`: non-empty string
 */
export class SigninDto {
  /**
   * User's email address. Must be a valid email format.
   * @example 'prince@abjexperts.com'
   */
  @ApiProperty({
    example: 'prince@abjexperts.com',
    description: 'User email address',
  })
  @IsEmail()
  email: string;

  /**
   * User's password. Must be a non-empty string.
   * @example 'Admin@123'
   */
  @ApiProperty({ example: 'Admin@123', description: 'User password' })
  @IsString()
  @MinLength(1)
  password: string;
}
