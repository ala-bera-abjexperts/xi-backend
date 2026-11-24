/**
 * @fileoverview DTO for querying/filtering audit log entries.
 * @module src/audit-logs/dto/list-audit-logs-query.dto
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

const AUDIT_ACTIONS = [
  'create',
  'update',
  'delete',
  'calculate',
  'archive',
  'restore',
] as const;

export class ListAuditLogsQueryDto {
  @ApiPropertyOptional({
    description: 'Filter by entity type (e.g. task, business_process)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  entity_type?: string;

  @ApiPropertyOptional({ description: 'Filter by entity UUID' })
  @IsOptional()
  @IsUUID()
  entity_id?: string;

  @ApiPropertyOptional({
    description:
      'Filter by any of these entity UUIDs (comma-separated, up to 50), e.g. a wiki page and its parent folders',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50 * 37)
  @Matches(/^[0-9a-f-]{36}(,[0-9a-f-]{36})*$/i, {
    message: 'entity_ids must be comma-separated UUIDs',
  })
  entity_ids?: string;

  @ApiPropertyOptional({ enum: AUDIT_ACTIONS, description: 'Filter by action' })
  @IsOptional()
  @IsIn(AUDIT_ACTIONS)
  action?: string;

  @ApiPropertyOptional({ description: 'Filter by user UUID' })
  @IsOptional()
  @IsUUID()
  user_id?: string;

  @ApiPropertyOptional({ description: 'Filter from date (ISO 8601)' })
  @IsOptional()
  @IsISO8601()
  start_date?: string;

  @ApiPropertyOptional({ description: 'Filter to date (ISO 8601)' })
  @IsOptional()
  @IsISO8601()
  end_date?: string;

  @ApiPropertyOptional({
    description: 'Number of records to return (1–100, default 50)',
    default: 50,
  })
  @IsOptional()
  @IsString()
  limit?: string;

  @ApiPropertyOptional({
    description: 'Number of records to skip (default 0)',
    default: 0,
  })
  @IsOptional()
  @IsString()
  offset?: string;
}
