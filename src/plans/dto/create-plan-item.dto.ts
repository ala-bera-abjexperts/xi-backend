import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export enum PlanItemType {
  PHASE = 'phase',
  WORK_PACKAGE = 'work_package',
  TASK = 'task',
  MILESTONE = 'milestone',
}

export enum PlanItemPriority {
  HIGHEST = 'highest',
  HIGH = 'high',
  MEDIUM = 'medium',
  LOW = 'low',
  LOWEST = 'lowest',
}

export class CreatePlanItemDto {
  @ApiPropertyOptional({
    description:
      'Legacy body field accepted for compatibility; route param wins.',
  })
  @IsOptional()
  @IsUUID()
  plan_id?: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(10000)
  description?: string;

  @ApiPropertyOptional({ enum: PlanItemType, default: PlanItemType.TASK })
  @IsOptional()
  @IsEnum(PlanItemType)
  item_type?: PlanItemType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  parent_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  start_date?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  end_date?: string;

  @ApiPropertyOptional({ description: 'Duration in days' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  duration_days?: number;

  @ApiPropertyOptional({ enum: PlanItemPriority })
  @IsOptional()
  @IsEnum(PlanItemPriority)
  priority?: PlanItemPriority;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  assigned_to?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  estimated_hours?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  estimated_cost?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  color?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  sort_order?: number;

  @ApiPropertyOptional({ description: 'Progress percentage 0-100' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  progress?: number;

  @ApiPropertyOptional({
    description: 'Link existing task instead of creating new',
  })
  @IsOptional()
  @IsUUID()
  linked_task_id?: string;

  @ApiPropertyOptional({
    description: 'Task type ID from task_hierarchy_configurations',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  task_type_id?: string;
}
