import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsUUID } from 'class-validator';

export class EffectivePeriodQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  to?: string;
}

export class UnitMembershipQueryDto extends EffectivePeriodQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  unit_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  user_id?: string;
}

export class CapacityPeriodQueryDto extends EffectivePeriodQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  user_id?: string;
}
