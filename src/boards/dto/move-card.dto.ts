/**
 * @fileoverview DTO for moving a card across columns.
 * @module src/boards/dto/move-card.dto
 * @author Prince Jadiya
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsUUID, Min } from 'class-validator';

export class MoveCardDto {
  @ApiPropertyOptional({
    description: 'Legacy organization UUID from Next clients (ignored)',
  })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiProperty()
  @IsUUID()
  task_id!: string;

  @ApiProperty()
  @IsUUID()
  source_column_id!: string;

  @ApiProperty()
  @IsUUID()
  target_column_id!: string;

  @ApiProperty({ example: 0, description: 'New position in target column' })
  @IsInt()
  @Min(0)
  new_position!: number;

  @ApiProperty({ description: 'Expected version for optimistic lock' })
  @IsInt()
  @Min(0)
  expected_version!: number;
}
