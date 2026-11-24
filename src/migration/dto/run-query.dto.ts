/**
 * @fileoverview Query DTOs for run listings, item listings, and log listings.
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class ListRunsQueryDto {
  @ApiPropertyOptional({ description: 'Filter runs to one job' })
  @IsOptional()
  @IsUUID()
  job_id?: string;
}

export class RunItemsQueryDto {
  @ApiPropertyOptional({
    enum: [
      'pending',
      'running',
      'sleeping',
      'succeeded',
      'failed',
      'skipped',
      'paused',
      'blocked',
      'dead',
    ],
  })
  @IsOptional()
  @IsIn([
    'pending',
    'running',
    'sleeping',
    'succeeded',
    'failed',
    'skipped',
    'paused',
    'blocked',
    'dead',
  ])
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  stage?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 500, default: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;

  @ApiPropertyOptional({ minimum: 0, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

export class RunLogsQueryDto {
  @ApiPropertyOptional({ enum: ['debug', 'info', 'warn', 'error'] })
  @IsOptional()
  @IsIn(['debug', 'info', 'warn', 'error'])
  level?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 1000, default: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;
}
