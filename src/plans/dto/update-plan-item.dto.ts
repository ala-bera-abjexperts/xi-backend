import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
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
  ValidateIf,
} from 'class-validator';
import { PlanItemType, PlanItemPriority } from './create-plan-item.dto';

export class UpdatePlanItemDto {
  @ApiPropertyOptional({
    description:
      'Legacy body field accepted for compatibility; route param wins.',
  })
  @IsOptional()
  @IsUUID()
  id?: string;

  @ApiPropertyOptional({
    description:
      'Legacy body field accepted for compatibility; route param wins.',
  })
  @IsOptional()
  @IsUUID()
  plan_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(10000)
  description?: string;

  @ApiPropertyOptional({ enum: PlanItemType })
  @IsOptional()
  @IsEnum(PlanItemType)
  item_type?: PlanItemType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  start_date?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  end_date?: string;

  @ApiPropertyOptional()
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
  actual_hours?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  estimated_cost?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  actual_cost?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  color?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  sort_order?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_critical_path?: boolean;

  @ApiPropertyOptional({ minimum: 0, maximum: 100 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  progress?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Parent task ID; send null to unset parent',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  parent_id?: string | null;

  @ApiPropertyOptional({
    description: 'Task type ID from task_hierarchy_configurations',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  task_type_id?: string;

  @ApiPropertyOptional({
    description:
      'Accepted for compatibility; ignored on update (used on create only)',
  })
  @IsOptional()
  @IsUUID()
  linked_task_id?: string;
}
