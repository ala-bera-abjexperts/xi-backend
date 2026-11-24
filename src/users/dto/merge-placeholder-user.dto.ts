/**
 * @fileoverview DTO for merging a migration placeholder user into a real member of the caller's
 * organization. Used by `POST /users/organization-members/:userId/merge`.
 * @module src/users/dto/merge-placeholder-user.dto
 * @author Prince Jadiya
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsUUID } from 'class-validator';

/** Body for merging a placeholder into a real member. */
export class MergePlaceholderUserDto {
  @ApiProperty({
    format: 'uuid',
    description: 'public.users.id of the real member that keeps the work',
  })
  @IsUUID()
  target_user_id!: string;

  @ApiPropertyOptional({
    description: 'Only count what would move; nothing changes',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  dry_run?: boolean;
}
