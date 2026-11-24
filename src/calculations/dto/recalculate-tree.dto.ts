/**
 * @fileoverview DTO for triggering a bottom-up tree recalculation.
 * @module src/calculations/dto/recalculate-tree.dto
 */

import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class RecalculateTreeDto {
  @ApiProperty({ description: 'Root process UUID for the tree to recalculate' })
  @IsUUID()
  root_process_id!: string;
}
