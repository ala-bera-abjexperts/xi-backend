import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsDefined,
  IsIn,
  IsNumber,
  IsOptional,
  IsUUID,
  Min,
  ValidateIf,
} from 'class-validator';

export function trimUpperString(value: unknown): unknown {
  return typeof value === 'string' ? value.trim().toUpperCase() : value;
}

export const SUPPORTED_CAPACITY_CURRENCIES = [
  'USD',
  'EUR',
  'GBP',
  'CHF',
  'JPY',
  'INR',
  'AUD',
  'CAD',
  'CNY',
  'SGD',
  'HKD',
  'AED',
  'ZAR',
  'NZD',
  'SEK',
  'NOK',
  'DKK',
  'MXN',
  'BRL',
  'PLN',
  'TRY',
  'THB',
  'IDR',
  'MYR',
  'PHP',
  'KRW',
  'ILS',
  'SAR',
  'EGP',
  'VND',
] as const;

export const CURRENCY_REQUIRED_FOR_RATE_MESSAGE =
  'currency is required when cost_rate is set';

export const UNSUPPORTED_CURRENCY_MESSAGE = `currency must be one of: ${SUPPORTED_CAPACITY_CURRENCIES.join(', ')}`;

/** Currency paired with `cost_rate`: required once a rate is set, blank means cleared. */
export function IsRateCurrency() {
  return applyDecorators(
    Transform(({ value }) => {
      const normalized = trimUpperString(value);
      return normalized === '' ? null : normalized;
    }),
    ValidateIf(
      (o: { cost_rate?: unknown; currency?: unknown }) =>
        o.cost_rate != null || o.currency != null,
    ),
    IsDefined({ message: CURRENCY_REQUIRED_FOR_RATE_MESSAGE }),
    IsIn(SUPPORTED_CAPACITY_CURRENCIES, {
      message: UNSUPPORTED_CURRENCY_MESSAGE,
    }),
  );
}

export class CreateCapacityPeriodDto {
  @ApiProperty()
  @IsUUID()
  user_id!: string;

  @ApiProperty({ format: 'date' })
  @IsDateString()
  effective_from!: string;

  @ApiPropertyOptional({ format: 'date', nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsDateString()
  effective_to?: string | null;

  @ApiProperty({ minimum: 0 })
  @IsNumber()
  @Min(0)
  weekly_capacity_hours!: number;

  @ApiPropertyOptional({ minimum: 0, nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  cost_rate?: number | null;

  @ApiPropertyOptional({ enum: SUPPORTED_CAPACITY_CURRENCIES, nullable: true })
  @IsRateCurrency()
  currency?: string | null;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}

export class UpdateCapacityPeriodDto extends PartialType(
  CreateCapacityPeriodDto,
) {}
