/**
 * @fileoverview Query DTO for the `GET /groups/memberships` reverse lookup.
 * @module src/user-groups/dto/group-memberships-query.dto
 */

import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';

/**
 * Upper bound on the ids one lookup may request.
 *
 * The ids land in a single `IN (...)` predicate, so this caps both the URL
 * length and the width of that query.
 */
export const GROUP_MEMBERSHIPS_MAX_USERS = 200;

/** Query parameters for the group-memberships reverse lookup. */
export class GroupMembershipsQueryDto {
  @ApiProperty({
    description: `Comma-separated user ids, up to ${GROUP_MEMBERSHIPS_MAX_USERS}.`,
    example:
      '3f6c1f0a-1f4c-4c2b-9c1e-2a5b6d7e8f90,7a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((id) => id.trim())
          .filter((id) => id.length > 0)
      : value,
  )
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(GROUP_MEMBERSHIPS_MAX_USERS)
  @IsUUID('4', { each: true })
  user_ids!: string[];
}
