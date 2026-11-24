import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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

export enum RiskType {
  RISK = 'risk',
  OPPORTUNITY = 'opportunity',
}

export enum RiskStatus {
  IDENTIFIED = 'identified',
  ANALYZING = 'analyzing',
  MITIGATING = 'mitigating',
  ACCEPTED = 'accepted',
  RESOLVED = 'resolved',
  OCCURRED = 'occurred',
}

export class CreatePlanRiskDto {
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

  @ApiPropertyOptional({ enum: RiskType, default: RiskType.RISK })
  @IsOptional()
  @IsEnum(RiskType)
  risk_type?: RiskType;

  @ApiPropertyOptional({
    description: 'Category (e.g. Technical, Schedule, Budget)',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string;

  @ApiPropertyOptional({ description: 'Probability 1-5', default: 3 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(5)
  probability?: number;

  @ApiPropertyOptional({ description: 'Impact 1-5', default: 3 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(5)
  impact?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  expected_value?: number;

  @ApiPropertyOptional({ enum: RiskStatus, default: RiskStatus.IDENTIFIED })
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

  @ApiPropertyOptional({ description: 'Associated task ID' })
  @IsOptional()
  @IsUUID()
  task_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  response_date?: string;

  @ApiPropertyOptional({
    description:
      'When true, the risk is a blocker (rendered under Blockers on portfolio letters and badged on the plan risk register).',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  is_blocker?: boolean;
}
