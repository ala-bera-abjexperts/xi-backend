import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { BadRequestException } from '@nestjs/common';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

export type HolidayRecurrence = 'fixed_annual' | 'one_off';

export class CreateHolidaySchemeDayDto {
  @ApiProperty()
  @IsUUID()
  scheme_id!: string;

  @ApiProperty({ maxLength: 255 })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @Matches(/\S/)
  name!: string;

  @ApiPropertyOptional({ nullable: true, maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @ApiProperty({ enum: ['fixed_annual', 'one_off'] })
  @IsIn(['fixed_annual', 'one_off'])
  recurrence!: HolidayRecurrence;

  @ApiPropertyOptional({ minimum: 1, maximum: 12, nullable: true })
  @ValidateIf(
    (dto: CreateHolidaySchemeDayDto) => dto.recurrence === 'fixed_annual',
  )
  @IsInt()
  @Min(1)
  @Max(12)
  month?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 31, nullable: true })
  @ValidateIf(
    (dto: CreateHolidaySchemeDayDto) => dto.recurrence === 'fixed_annual',
  )
  @IsInt()
  @Min(1)
  @Max(31)
  day?: number;

  @ApiPropertyOptional({ format: 'date', nullable: true })
  @ValidateIf((dto: CreateHolidaySchemeDayDto) => dto.recurrence === 'one_off')
  @IsDateString()
  holiday_date?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1, maximum: 60 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60)
  duration_days?: number;
}

export class UpdateHolidaySchemeDayDto extends PartialType(
  CreateHolidaySchemeDayDto,
) {}

/**
 * Mirrors the DB's `holiday_scheme_days_shape_check` in application code so a
 * bad request is rejected with a clear 400 before it ever reaches Postgres,
 * rather than surfacing as an opaque constraint-violation 500.
 */
export function assertHolidaySchemeDayShape(dto: {
  recurrence?: HolidayRecurrence;
  month?: number | null;
  day?: number | null;
  holiday_date?: string | null;
}): void {
  if (dto.recurrence === 'fixed_annual') {
    if (dto.month == null || dto.day == null) {
      throw new BadRequestException(
        'fixed_annual holidays require both month and day',
      );
    }
    if (dto.holiday_date != null) {
      throw new BadRequestException(
        'fixed_annual holidays must not set holiday_date',
      );
    }
  } else if (dto.recurrence === 'one_off') {
    if (dto.holiday_date == null) {
      throw new BadRequestException('one_off holidays require holiday_date');
    }
    if (dto.month != null || dto.day != null) {
      throw new BadRequestException(
        'one_off holidays must not set month or day',
      );
    }
  }
}
