/**
 * @fileoverview DTO for adding a member to a space.
 * Supports user, group, and role member types.
 * @module src/spaces/dto/create-space-member.dto
 * @author Prince Jadiya
 */

import { IsString, IsOptional, IsIn, IsObject, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Data transfer object for adding a member to a space.
 *
 * The `member_type` determines which ID field is required:
 * - `user` requires `user_id`
 * - `group` requires `group_id`
 * - `role` requires `role_id`
 */
export class CreateSpaceMemberDto {
  /** Type of member being added */
  @ApiProperty({
    example: 'user',
    enum: ['user', 'group', 'role'],
    description: 'Type of member (user, group, or role)',
  })
  @IsString()
  @IsIn(['user', 'group', 'role'])
  member_type: string;

  /** UUID of the user (required when member_type is 'user') */
  @ApiPropertyOptional({ description: 'UUID of the user to add' })
  @IsOptional()
  @IsString()
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, {
    message: 'user_id must be a UUID',
  })
  user_id?: string;

  /** UUID of the group (required when member_type is 'group') */
  @ApiPropertyOptional({ description: 'UUID of the group to add' })
  @IsOptional()
  @IsString()
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, {
    message: 'group_id must be a UUID',
  })
  group_id?: string;

  /** UUID of the role (required when member_type is 'role') */
  @ApiPropertyOptional({ description: 'UUID of the role to add' })
  @IsOptional()
  @IsString()
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, {
    message: 'role_id must be a UUID',
  })
  role_id?: string;

  /** Space role to assign (e.g., 'admin', 'member', 'viewer') */
  @ApiPropertyOptional({
    example: 'member',
    description: 'Space role to assign',
  })
  @IsOptional()
  @IsString()
  space_role?: string;

  /** Custom permissions override (JSON object) */
  @ApiPropertyOptional({
    description: 'Custom permissions (JSON object)',
  })
  @IsOptional()
  @IsObject()
  permissions?: Record<string, boolean>;

  /** Notification preferences override (JSON object) */
  @ApiPropertyOptional({
    description: 'Notification preferences (JSON object)',
  })
  @IsOptional()
  @IsObject()
  notification_preferences?: Record<string, unknown>;

  /** Space UUID (ignored — comes from URL param; accepted to avoid 400 when risk-management-app includes it in body) */
  @ApiPropertyOptional({ description: 'Space UUID (ignored, use URL param)' })
  @IsOptional()
  @IsString()
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, {
    message: 'space_id must be a UUID',
  })
  space_id?: string;
}
