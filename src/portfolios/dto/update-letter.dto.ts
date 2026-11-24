import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsDateString,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class UpdateLetterDto {
  @ApiPropertyOptional({ enum: ['green', 'amber', 'red'] })
  @IsOptional()
  @IsIn(['green', 'amber', 'red'])
  rag_schedule?: 'green' | 'amber' | 'red' | null;

  @ApiPropertyOptional({ enum: ['green', 'amber', 'red'] })
  @IsOptional()
  @IsIn(['green', 'amber', 'red'])
  rag_budget?: 'green' | 'amber' | 'red' | null;

  @ApiPropertyOptional({ enum: ['green', 'amber', 'red'] })
  @IsOptional()
  @IsIn(['green', 'amber', 'red'])
  rag_quality?: 'green' | 'amber' | 'red' | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  key_message?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  milestones_achieved?: unknown[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  success_factors?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  planned_vs_actual?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  next_steps?: unknown[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(999.99)
  budget_consumption_percent?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  resource_availability?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  identified_risks?: unknown[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  blockers?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  due_date?: string | null;

  @ApiPropertyOptional({
    description:
      'Reassign this letter to another user. Managers only; must always resolve to a non-null user.',
  })
  @IsOptional()
  @IsUUID()
  assigned_to_user_id?: string | null;
}
