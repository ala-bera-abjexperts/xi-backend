/**
 * @fileoverview DTO for reordering cards within a column.
 * @module src/boards/dto/reorder-cards.dto
 * @author Prince Jadiya
 */

import { ApiProperty } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsOptional, IsUUID } from 'class-validator';

export class ReorderCardsDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiProperty()
  @IsUUID()
  column_id!: string;

  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('4', { each: true })
  task_ids!: string[];
}
