import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsNumber, IsOptional, IsUUID } from 'class-validator';

export enum DependencyType {
  FINISH_TO_START = 'finish_to_start',
  START_TO_START = 'start_to_start',
  FINISH_TO_FINISH = 'finish_to_finish',
  START_TO_FINISH = 'start_to_finish',
}

export class CreatePlanDependencyDto {
  @ApiPropertyOptional({
    description:
      'Legacy body field accepted for compatibility; route param wins.',
  })
  @IsOptional()
  @IsUUID()
  plan_id?: string;

  @ApiProperty({ description: 'Predecessor task ID' })
  @IsUUID()
  predecessor_id!: string;

  @ApiProperty({ description: 'Successor task ID' })
  @IsUUID()
  successor_id!: string;

  @ApiPropertyOptional({
    enum: DependencyType,
    default: DependencyType.FINISH_TO_START,
  })
  @IsOptional()
  @IsEnum(DependencyType)
  dependency_type?: DependencyType;

  @ApiPropertyOptional({ description: 'Lag in days (negative = lead)' })
  @IsOptional()
  @IsNumber()
  lag_days?: number;
}
