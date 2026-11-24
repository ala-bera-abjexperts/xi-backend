/**
 * @fileoverview Data Transfer Object for creating organization invitations.
 * Validates the invitee's email, name, and optional role before creating
 * an invitation record and sending the invitation email.
 * @module src/invitations/dto/create-invitation.dto
 * @author Prince Jadiya
 */

import {
  IsEmail,
  IsString,
  MinLength,
  IsOptional,
  IsIn,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * DTO for the `POST /invitations` endpoint.
 *
 * Validation rules:
 * - `email`: valid email format
 * - `firstName`: non-empty string
 * - `lastName`: non-empty string
 * - `role`: optional, must be one of `'member'`, `'admin'`, `'viewer'` (defaults to `'member'`)
 */
export class CreateInvitationDto {
  /**
   * Email address of the person to invite.
   * @example 'invitee@example.com'
   */
  @ApiProperty({
    example: 'invitee@example.com',
    description: 'Email address of the person to invite',
  })
  @IsEmail()
  email: string;

  /**
   * First name of the invitee.
   * @example 'John'
   */
  @ApiProperty({ example: 'John', description: 'First name of the invitee' })
  @IsString()
  @MinLength(1)
  firstName: string;

  /**
   * Last name of the invitee.
   * @example 'Doe'
   */
  @ApiProperty({ example: 'Doe', description: 'Last name of the invitee' })
  @IsString()
  @MinLength(1)
  lastName: string;

  /**
   * Organization role to assign to the invitee. Defaults to `'member'` if not specified.
   * @example 'member'
   */
  @ApiPropertyOptional({
    example: 'member',
    description: 'Role to assign (defaults to member)',
    enum: ['member', 'admin', 'viewer'],
  })
  @IsOptional()
  @IsIn(['member', 'admin', 'viewer'])
  role?: string;
}
