/**
 * @fileoverview Scope selection for a migration job — which slices of the source
 * project/space are included. Stored as `migration_jobs.scope` (jsonb).
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class MigrationScopeDto {
  @ApiPropertyOptional({
    description:
      'Source issue type ids to include; omitted/empty means all issue types',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  issue_type_ids?: string[];

  @ApiProperty({ description: 'Include boards (and their sprints)' })
  @IsBoolean()
  include_boards!: boolean;

  @ApiProperty({ description: 'Include issue comments' })
  @IsBoolean()
  include_comments!: boolean;

  @ApiProperty({ description: 'Include attachments' })
  @IsBoolean()
  include_attachments!: boolean;

  @ApiProperty({ description: 'Include issue links' })
  @IsBoolean()
  include_links!: boolean;

  @ApiPropertyOptional({
    description: 'Optional JQL filter narrowing which issues are migrated',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  jql?: string;
}
