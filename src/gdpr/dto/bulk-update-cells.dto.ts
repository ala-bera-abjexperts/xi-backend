/**
 * @fileoverview DTO for bulk updating cells across multiple GDPR records.
 * Matches risk-management-app bulkCellUpdateSchema: per-column granular updates.
 * @module src/gdpr/dto/bulk-update-cells.dto
 */

import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';

export class CellUpdateItemDto {
  @ApiProperty({ description: 'Record UUID to update' })
  @IsUUID()
  record_id!: string;

  @ApiProperty({
    description: 'Column key to update (matches columnId in column_config)',
  })
  @IsString()
  column_id!: string;

  @ApiProperty({ description: 'New value for the cell (any type)' })
  value!: unknown;

  @ApiProperty({
    minimum: 1,
    description: 'Current record version for optimistic locking',
  })
  @IsInt()
  @Min(1)
  version!: number;
}

export class BulkUpdateCellsDto {
  @ApiProperty({ type: [CellUpdateItemDto], description: 'Max 100 items' })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CellUpdateItemDto)
  updates!: CellUpdateItemDto[];
}
