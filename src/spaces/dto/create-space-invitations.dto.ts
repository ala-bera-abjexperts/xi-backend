/**
 * @fileoverview DTO for bulk-inviting users to a space.
 * @module src/spaces/dto/create-space-invitations.dto
 * @author Prince Jadiya
 */

import { Type } from 'class-transformer';
import {
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Represents a single user entry within the bulk invitation payload.
 */
export class SpaceInvitationUserDto {
  /** UUID of the user to invite */
  @ApiProperty({ description: 'UUID of the user to invite' })
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, {
    message: 'user_id must be a UUID',
  })
  user_id: string;

  /** Space role to assign (e.g., 'admin', 'member', 'viewer') */
  @ApiProperty({
    example: 'member',
    description: 'Space role to assign',
  })
  @IsString()
  space_role: string;

  /** Optional custom role ID */
  @ApiPropertyOptional({ description: 'Optional custom role ID to assign' })
  @IsOptional()
  @IsUUID()
  custom_role_id?: string;

  /** Optional space-level permissions to assign */
  @ApiPropertyOptional({
    description: 'Optional space-level permissions to assign',
    type: 'object',
    additionalProperties: { type: 'boolean' },
  })
  @IsOptional()
  space_permissions?: Record<string, boolean>;
}

/**
 * Data transfer object for bulk-inviting users to a space.
 */
export class CreateSpaceInvitationsDto {
  /** Array of users to invite */
  @ApiProperty({
    type: [SpaceInvitationUserDto],
    description: 'Array of users to invite to the space',
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SpaceInvitationUserDto)
  users: SpaceInvitationUserDto[];
}
