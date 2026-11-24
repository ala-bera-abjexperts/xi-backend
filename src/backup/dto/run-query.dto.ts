/**
 * @fileoverview Query filters for listing backup runs.
 * @module src/backup/dto/run-query.dto
 *
 * The global ValidationPipe runs with `forbidNonWhitelisted`, so an unrecognised query key is a 400
 * rather than a silently ignored filter.
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

export const BACKUP_RUN_STATUSES = [
  'queued',
  'preflight',
  'exporting',
  'packaging',
  'uploading',
  'verifying',
  'succeeded',
  'partially_completed',
  'failed',
  'cancelled',
] as const;

export class RunQueryDto {
  @ApiPropertyOptional({ description: 'Only runs of this scheme' })
  @IsOptional()
  @IsUUID()
  schemeId?: string;

  @ApiPropertyOptional({ enum: BACKUP_RUN_STATUSES })
  @IsOptional()
  @IsIn(BACKUP_RUN_STATUSES as unknown as string[])
  status?: string;

  @ApiPropertyOptional({ default: 50, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
