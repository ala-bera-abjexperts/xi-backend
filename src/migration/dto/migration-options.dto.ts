/**
 * @fileoverview Execution options for a migration job (mode, batching, macro and
 * user-mapping strategies). Stored as `migration_jobs.options` (jsonb).
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';

export enum MigrationMode {
  DRY_RUN = 'dry_run',
  LIVE = 'live',
}

export enum MacroStrategy {
  SEMANTIC = 'semantic',
  FALLBACK = 'fallback',
}

export enum UserMappingMode {
  MATCH_OR_PLACEHOLDER = 'match_or_placeholder',
}

export class MigrationOptionsDto {
  @ApiProperty({ enum: MigrationMode })
  @IsEnum(MigrationMode)
  mode!: MigrationMode;

  @ApiProperty({
    description: 'Items per batch when iterating the source (10–100)',
    minimum: 10,
    maximum: 100,
  })
  @IsInt()
  @Min(10)
  @Max(100)
  batch_size!: number;

  @ApiProperty({ enum: MacroStrategy })
  @IsEnum(MacroStrategy)
  macro_strategy!: MacroStrategy;

  @ApiProperty({ enum: UserMappingMode })
  @IsEnum(UserMappingMode)
  user_mapping!: UserMappingMode;

  @ApiPropertyOptional({
    description:
      'Create a real XISUITE account for every source user who has a usable email and no existing ' +
      'account, and mail them a set-password link. Defaults to false. Outward-facing and ' +
      "irreversible (real logins, one message per user through the deployment's own relay), so " +
      "review the dry-run preview's `wouldCreate` list before enabling it.",
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  provision_users?: boolean;

  @ApiPropertyOptional({
    description:
      'Invite every source user who has a usable email but no account in this organization. Jira ' +
      'administrators are invited as admin, everyone else as member; accepting hands them their migrated ' +
      'work and project roles. Defaults to false; never sends during a dry run.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  invite_users?: boolean;
}
