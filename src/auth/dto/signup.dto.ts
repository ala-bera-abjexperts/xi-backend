/**
 * @fileoverview Data Transfer Object for user registration requests.
 * Validates that all required fields are present and well-formed before
 * the signup flow creates a Supabase auth user and sends an OTP email.
 * @module src/auth/dto/signup.dto
 * @author Prince Jadiya
 */

import { IsEmail, IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * DTO for the `POST /auth/signup` endpoint.
 *
 * Validation rules:
 * - `firstName`: non-empty string
 * - `lastName`: non-empty string
 * - `email`: valid email format
 * - `password`: string with minimum 6 characters
 */
export class SignupDto {
  /**
   * User's first name.
   * @example 'Prince'
   */
  @ApiProperty({ example: 'Prince', description: 'User first name' })
  @IsString()
  @MinLength(1)
  firstName: string;

  /**
   * User's last name.
   * @example 'Jadiya'
   */
  @ApiProperty({ example: 'Jadiya', description: 'User last name' })
  @IsString()
  @MinLength(1)
  lastName: string;

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

  /**
   * User's password. Must be at least 6 characters long.
   * @example 'SecurePass123'
   */
  @ApiProperty({
    example: 'SecurePass123',
    description: 'Password (min 6 characters)',
    minLength: 6,
  })
  @IsString()
  @MinLength(6)
  password: string;
}
