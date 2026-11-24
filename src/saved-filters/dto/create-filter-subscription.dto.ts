import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateFilterSubscriptionDto {
  @ApiPropertyOptional({
    description: 'Legacy client org id; ignored in favor of auth context',
  })
  @IsOptional()
  @IsString()
  organizationId?: string;

  @ApiProperty({
    description: 'Cron expression e.g. "0 9 * * *"',
    maxLength: 100,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  schedule_cron!: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  schedule_label?: string | null;

  @ApiPropertyOptional({
    enum: ['daily', 'weekly', 'monthly', 'yearly'],
    default: 'daily',
  })
  @IsOptional()
  @IsIn(['daily', 'weekly', 'monthly', 'yearly'])
  schedule_frequency?: 'daily' | 'weekly' | 'monthly' | 'yearly';

  @ApiPropertyOptional({ description: 'Time of day HH:MM' })
  @IsOptional()
  @IsString()
  schedule_time?: string;

  @ApiPropertyOptional({
    type: [Number],
    description: 'Days of week 0-6 (for weekly)',
  })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  schedule_days_of_week?: number[];

  @ApiPropertyOptional({ minimum: 1, maximum: 31 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(31)
  schedule_day_of_month?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 12 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  schedule_month_of_year?: number;

  @ApiPropertyOptional({ enum: ['never', 'date', 'count'], default: 'never' })
  @IsOptional()
  @IsIn(['never', 'date', 'count'])
  end_type?: 'never' | 'date' | 'count';

  @ApiPropertyOptional({ description: 'ISO date when end_type=date' })
  @IsOptional()
  @IsDateString()
  end_date?: string | null;

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  max_occurrences?: number | null;
}
