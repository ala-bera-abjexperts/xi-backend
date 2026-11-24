import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';

export class UpdateTimeEntryDto {
  @ApiPropertyOptional({ description: 'Duration in minutes', minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1, { message: 'Duration must be greater than 0' })
  duration_minutes?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  note?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  logged_at?: string;

  @ApiPropertyOptional({
    description: 'Legacy body value ignored; org is derived from auth context',
  })
  @IsOptional()
  @IsUUID()
  organizationId?: string;
}
