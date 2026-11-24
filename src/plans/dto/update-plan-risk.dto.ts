import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { RiskType, RiskStatus } from './create-plan-risk.dto';

export class UpdatePlanRiskDto {
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

  @ApiPropertyOptional({ enum: RiskType })
  @IsOptional()
  @IsEnum(RiskType)
  risk_type?: RiskType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(5)
  probability?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(5)
  impact?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  expected_value?: number;

  @ApiPropertyOptional({ enum: RiskStatus })
  @IsOptional()
  @IsEnum(RiskStatus)
  status?: RiskStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  mitigation_strategy?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  contingency_plan?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  owner_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  task_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  response_date?: string;

  @ApiPropertyOptional({
    description: 'Toggle the blocker flag on an existing plan risk.',
  })
  @IsOptional()
  @IsBoolean()
  is_blocker?: boolean;
}
