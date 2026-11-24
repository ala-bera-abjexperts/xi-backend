/**
 * @fileoverview DTO for starting a migration run. Mode defaults to the job's saved
 * option (dry_run unless configured otherwise) — the override lets the UI offer an
 * explicit "Run live" action after a successful dry run.
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

export class StartRunDto {
  @ApiPropertyOptional({ enum: ['dry_run', 'live'] })
  @IsOptional()
  @IsIn(['dry_run', 'live'])
  mode?: 'dry_run' | 'live';
}

/** Omitted scope preserves the existing full-import repair. */
export class RepairRunDto {
  @ApiPropertyOptional({ enum: ['profile_macros'] })
  @IsOptional()
  @IsIn(['profile_macros'])
  scope?: 'profile_macros';
}
