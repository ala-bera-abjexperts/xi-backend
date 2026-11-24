/**
 * @fileoverview Data Transfer Object for accepting an invitation.
 * Validates that a secure invitation token is provided for verification
 * during the invitation acceptance flow.
 * @module src/invitations/dto/accept-invitation.dto
 * @author Prince Jadiya
 */

import { IsOptional, IsString, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * DTO for the `POST /invitations/:id/accept` endpoint.
 *
 * Validation rules:
 * - `token`: non-empty string (the 64-character hex token from the invitation email)
 */
export class AcceptInvitationDto {
  /**
   * The secure invitation token received via the invitation email link.
   * Must match the token stored in the invitation record.
   * @example 'a1b2c3d4e5f6...'
   */
  @ApiProperty({
    example: 'a1b2c3d4e5f6...',
    description: 'Secure invitation token received via email',
  })
  @IsString()
  @MinLength(1)
  token: string;

  /**
   * Optional password for first-time invite acceptance. When present, the
   * backend creates or updates the Supabase Auth user and signs them in.
   */
  @ApiPropertyOptional({
    example: 'Admin@123',
    description: 'Password to set for first-time invited users',
  })
  @IsOptional()
  @IsString()
  @MinLength(6)
  password?: string;
}
