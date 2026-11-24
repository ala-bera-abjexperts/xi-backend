import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsNumber,
  IsOptional,
  IsUUID,
  ValidateNested,
} from 'class-validator';

export class ReorderItemEntry {
  @ApiPropertyOptional({
    description: 'Legacy alias for task_id. task.id, not plan_tasks.id.',
  })
  @IsOptional()
  @IsUUID()
  id?: string;

  @ApiProperty({ description: 'task.id (not plan_tasks.id)' })
  @IsOptional()
  @IsUUID()
  task_id?: string;

  @ApiProperty()
  @IsNumber()
  sort_order!: number;

  @ApiPropertyOptional({
    description: 'New parent task ID (optional reparent)',
  })
  @IsOptional()
  @IsUUID()
  parent_task_id?: string | null;

  @ApiPropertyOptional({
    description: 'Legacy alias for parent_task_id.',
  })
  @IsOptional()
  @IsUUID()
  parent_id?: string | null;
}

export class ReorderPlanItemsDto {
  @ApiProperty({ type: [ReorderItemEntry] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReorderItemEntry)
  items!: ReorderItemEntry[];
}
