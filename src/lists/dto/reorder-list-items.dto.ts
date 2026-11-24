/**
 * @fileoverview DTO for reordering list items.
 * @module src/lists/dto/reorder-list-items.dto
 * @author Prince Jadiya
 */

import { ApiProperty } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsUUID } from 'class-validator';

export class ReorderListItemsDto {
  @ApiProperty({ description: 'List schema UUID' })
  @IsUUID()
  list_id!: string;

  @ApiProperty({
    type: [String],
    description: 'Item IDs in their desired order',
  })
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('4', { each: true })
  item_ids!: string[];
}
