/**
 * @fileoverview Request DTO for POST /admin/impersonation/start.
 * Validation mirrors the DB CHECK constraints on impersonation_sessions
 * (reason length 5-500, duration ≤ 30 min) so invalid inputs are rejected
 * by class-validator before any DB round-trip.
 * @module src/impersonation/dto/start-impersonation.dto
 */

import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  Max,
  Min,
} from 'class-validator';

export class StartImpersonationDto {
  @IsUUID('4')
  tenantId!: string;

  @IsUUID('4')
  targetUserId!: string;

  @IsString()
  @Length(5, 500)
  reason!: string;

  @IsOptional()
  @IsBoolean()
  writeAccess?: boolean;

  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(30) // hard 30-min cap (DB CHECK constraint enforces this too)
  durationMinutes?: number;

  /** Full browser URL of the Super Admin page that initiated impersonation. */
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  returnTo?: string;
}
