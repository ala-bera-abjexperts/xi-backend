/**
 * @fileoverview DTO for tracking a recent item access. Validates the item details
 * required to record or update an entry in the `user_recent_items` table.
 * @module src/users/dto/track-recent-item.dto
 * @author Prince Jadiya
 */

import { IsString, IsUUID, IsOptional, IsObject } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Data transfer object for the POST /users/recent-items endpoint.
 *
 * Records or updates a recently accessed item for the authenticated user.
 */
export class TrackRecentItemDto {
  /** Type of item accessed (e.g., 'space', 'page', 'issue') */
  @ApiProperty({ example: 'space', description: 'Type of item accessed' })
  @IsString()
  item_type: string;

  /** UUID of the accessed item */
  @ApiProperty({
    example: '550e8400-e29b-41d4-a716-446655440000',
    description: 'UUID of the accessed item',
  })
  @IsUUID()
  item_id: string;

  /** Display name of the item */
  @ApiProperty({
    example: 'Project Alpha',
    description: 'Display name of the item',
  })
  @IsString()
  item_name: string;

  /** Short key/identifier for the item (e.g., 'PA-123') */
  @ApiPropertyOptional({
    example: 'PA-123',
    description: 'Short key or identifier',
  })
  @IsOptional()
  @IsString()
  item_key?: string;

  /** Icon identifier for the item */
  @ApiPropertyOptional({ example: 'folder', description: 'Icon identifier' })
  @IsOptional()
  @IsString()
  item_icon?: string;

  /** Additional metadata as a JSON object */
  @ApiPropertyOptional({
    example: { color: '#ff0000' },
    description: 'Additional metadata',
  })
  @IsOptional()
  @IsObject()
  item_metadata?: Record<string, any>;
}
