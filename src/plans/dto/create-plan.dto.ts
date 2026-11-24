import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsEnum,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export enum PlanType {
  WATERFALL = 'waterfall',
  AGILE = 'agile',
  HYBRID = 'hybrid',
  IPMA = 'ipma',
}

export enum PlanStatus {
  DRAFT = 'draft',
  ACTIVE = 'active',
  ON_HOLD = 'on_hold',
  COMPLETED = 'completed',
  ARCHIVED = 'archived',
}

export class CreatePlanDto {
  @ApiProperty()
  @IsOptional()
  @IsUUID()
  space_id?: string;

  @ApiPropertyOptional({
    description: 'Legacy camelCase space field accepted for compatibility.',
  })
  @IsOptional()
  @IsUUID()
  spaceId?: string;

  @ApiPropertyOptional({
    description:
      'Legacy camelCase organization field accepted for compatibility; auth context wins.',
  })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiPropertyOptional({
    description:
      'Legacy snake_case organization field accepted for compatibility; auth context wins.',
  })
  @IsOptional()
  @IsUUID()
  organization_id?: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @ApiPropertyOptional({ enum: PlanType, default: PlanType.WATERFALL })
  @IsOptional()
  @IsEnum(PlanType)
  plan_type?: PlanType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  start_date?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  end_date?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  budget?: number;

  @ApiPropertyOptional({ default: 'EUR' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  currency?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  owner_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  settings?: Record<string, unknown>;
}
