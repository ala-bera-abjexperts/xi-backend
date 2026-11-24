import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';

export class CreateTimeEntryDto {
  @ApiProperty()
  @IsOptional()
  @IsUUID()
  task_id?: string;

  @ApiPropertyOptional({ description: 'Legacy body alias for task_id' })
  @IsOptional()
  @IsUUID()
  taskId?: string;

  @ApiPropertyOptional({
    description: 'Legacy body value ignored; org is derived from auth context',
  })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiProperty({ description: 'Duration in minutes', minimum: 1 })
  @IsInt()
  @Min(1, { message: 'Duration must be greater than 0' })
  duration_minutes!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  note?: string | null;

  @ApiPropertyOptional({ description: 'ISO datetime when the timer started' })
  @IsOptional()
  @IsDateString()
  started_at?: string | null;

  @ApiPropertyOptional({
    description: 'ISO datetime when the time was logged (defaults to now)',
  })
  @IsOptional()
  @IsDateString()
  logged_at?: string;
}
