/**
 * @fileoverview DTOs for changing organization roles of members inside the caller's
 * own tenant. Used by the `PATCH /users/organization-members/...` routes.
 * @module src/users/dto/update-organization-member-role.dto
 */

import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsUUID,
} from 'class-validator';

/**
 * The four values `organization_members.role` accepts, mirroring the DB CHECK
 * constraint and `RequestUserMembership.role`.
 */
export const ORGANIZATION_MEMBER_ROLES = [
  'owner',
  'admin',
  'member',
  'viewer',
] as const;

/** Union of the values in {@link ORGANIZATION_MEMBER_ROLES}. */
export type OrganizationMemberRole = (typeof ORGANIZATION_MEMBER_ROLES)[number];

/**
 * Upper bound on a single bulk role change.
 *
 * The bulk method issues one round-trip per user id, so an unbounded array
 * would let one request hold a connection for an arbitrarily long time.
 */
export const BULK_ROLE_CHANGE_MAX_USERS = 200;

/** Body for changing one member's organization role. */
export class UpdateOrganizationMemberRoleDto {
  @ApiProperty({
    enum: ORGANIZATION_MEMBER_ROLES,
    example: 'admin',
    description:
      "The member's new organization role. Granting or revoking 'owner' requires the caller to be an owner.",
  })
  @IsIn([...ORGANIZATION_MEMBER_ROLES])
  role!: OrganizationMemberRole;
}

/** Body for changing the organization role of several members at once. */
export class BulkUpdateOrganizationMemberRoleDto extends UpdateOrganizationMemberRoleDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    maxItems: BULK_ROLE_CHANGE_MAX_USERS,
    example: ['3f6c1f0a-1f4c-4c2b-9c1e-2a5b6d7e8f90'],
    description: `Users to update, up to ${BULK_ROLE_CHANGE_MAX_USERS}. Applied per user, so the response reports partial success.`,
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(BULK_ROLE_CHANGE_MAX_USERS)
  @IsUUID('4', { each: true })
  user_ids!: string[];
}

/** Body for removing several members from the organization at once. */
export class BulkRemoveOrganizationMembersDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    maxItems: BULK_ROLE_CHANGE_MAX_USERS,
    example: ['3f6c1f0a-1f4c-4c2b-9c1e-2a5b6d7e8f90'],
    description: `Users to remove, up to ${BULK_ROLE_CHANGE_MAX_USERS}. Applied per user, so the response reports partial success.`,
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(BULK_ROLE_CHANGE_MAX_USERS)
  @IsUUID('4', { each: true })
  user_ids!: string[];
}
