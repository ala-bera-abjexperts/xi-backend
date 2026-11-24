import {
  ApiProperty,
  ApiPropertyOptional,
  OmitType,
  PartialType,
} from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Matches,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import {
  SUPPORTED_CAPACITY_CURRENCIES,
  trimUpperString,
  UNSUPPORTED_CURRENCY_MESSAGE,
} from './capacity-period.dto';
import { EffectivePeriodQueryDto } from './resource-planning-common.dto';

export enum BudgetEntryType {
  PLANNED = 'planned',
  ACTUAL = 'actual',
}

export class CreateBudgetEntryDto {
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  plan_id?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  task_id?: string | null;

  @ApiProperty({ enum: BudgetEntryType })
  @IsEnum(BudgetEntryType)
  entry_type!: BudgetEntryType;

  @ApiProperty({ maxLength: 255 })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @Matches(/\S/)
  name!: string;

  @ApiPropertyOptional({ nullable: true, maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Matches(/\S/)
  category?: string | null;

  @ApiPropertyOptional({ default: 1, minimum: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  quantity?: number;

  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  unit_cost?: number;

  @ApiProperty({ enum: SUPPORTED_CAPACITY_CURRENCIES })
  @Transform(({ value }) => trimUpperString(value))
  @IsString()
  @IsIn(SUPPORTED_CAPACITY_CURRENCIES, {
    message: UNSUPPORTED_CURRENCY_MESSAGE,
  })
  currency!: string;

  @ApiProperty({ format: 'date' })
  @IsDateString()
  effective_date!: string;

  @ApiPropertyOptional({ nullable: true, maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;

  /** Resource Planning 2.0, Sub Task 1. Optional catalog reference; legacy `category` text is unaffected. */
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  cost_category_id?: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'date' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsDateString()
  start_date?: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'date' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsDateString()
  end_date?: string | null;

  /** manual (default): amount is a real cost fact. rollup_*: computed live from children, excluded from cost reporting. */
  @ApiPropertyOptional({
    enum: ['manual', 'rollup_sum', 'rollup_avg', 'rollup_max'],
    default: 'manual',
  })
  @IsOptional()
  @IsIn(['manual', 'rollup_sum', 'rollup_avg', 'rollup_max'])
  aggregation?: 'manual' | 'rollup_sum' | 'rollup_avg' | 'rollup_max';
}

export class UpdateBudgetEntryDto extends PartialType(
  OmitType(CreateBudgetEntryDto, ['plan_id', 'task_id'] as const),
) {}

export class BudgetEntryQueryDto extends EffectivePeriodQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  plan_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  task_id?: string;

  /** Space-scoped view: requires task_id or plan_id, which must live in this space. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  space_id?: string;

  @ApiPropertyOptional({ enum: BudgetEntryType })
  @IsOptional()
  @IsEnum(BudgetEntryType)
  entry_type?: BudgetEntryType;
}
