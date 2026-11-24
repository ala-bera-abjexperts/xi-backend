/**
 * @fileoverview DTO for toggling a starred space. Validates the space ID
 * required to star or unstar a space in the `starred_spaces` table.
 * @module src/users/dto/toggle-star.dto
 * @author Prince Jadiya
 */

import { IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Data transfer object for the POST /users/starred-spaces endpoint.
 *
 * If the space is already starred, it will be unstarred (toggled).
 */
export class ToggleStarDto {
  /** UUID of the space to star or unstar */
  @ApiProperty({
    example: '550e8400-e29b-41d4-a716-446655440000',
    description: 'UUID of the space to star or unstar',
  })
  @IsUUID()
  space_id: string;
}
