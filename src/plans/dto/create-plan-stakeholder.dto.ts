import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
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

export enum StakeholderAttitude {
  SUPPORTIVE = 'supportive',
  NEUTRAL = 'neutral',
  RESISTANT = 'resistant',
}

export class CreatePlanStakeholderDto {
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
  @MaxLength(255)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  role?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  user_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  organization_name?: string;

  @ApiPropertyOptional({
    description: 'Power/influence level 1-10',
    default: 5,
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(10)
  power_level?: number;

  @ApiPropertyOptional({ description: 'Interest level 1-10', default: 5 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(10)
  interest_level?: number;

  @ApiPropertyOptional({ enum: StakeholderAttitude })
  @IsOptional()
  @IsEnum(StakeholderAttitude)
  attitude?: StakeholderAttitude;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  engagement_strategy?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
