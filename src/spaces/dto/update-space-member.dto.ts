/**
 * @fileoverview DTO for updating a space member's role.
 * @module src/spaces/dto/update-space-member.dto
 * @author Prince Jadiya
 */

import { IsString, IsOptional, IsUUID } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Data transfer object for updating a space member's role.
 */
export class UpdateSpaceMemberDto {
  /** UUID of the space member record */
  @ApiProperty({ description: 'UUID of the space_members record to update' })
  @IsUUID()
  member_id: string;

  /** New space role to assign */
  @ApiPropertyOptional({
    example: 'admin',
    description: 'New space role to assign',
  })
  @IsOptional()
  @IsString()
  space_role?: string;
}
