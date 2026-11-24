/**
 * @fileoverview Query DTO for GET /admin/impersonation/history. All filters are
 * optional; numeric and boolean values are parsed from query strings via
 * class-transformer @Transform decorators.
 * @module src/impersonation/dto/impersonation-history-query.dto
 */

import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export class ImpersonationHistoryQueryDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Transform(({ value }) => parseInt(value, 10))
  page?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Transform(({ value }) => parseInt(value, 10))
  limit?: number;

  @IsOptional()
  @IsUUID('4')
  tenantId?: string;

  @IsOptional()
  @IsUUID('4')
  targetUserId?: string;

  @IsOptional()
  @IsUUID('4')
  superAdminUserId?: string;

  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true')
  activeOnly?: boolean;
}
