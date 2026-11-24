/**
 * @fileoverview What a scheme backs up: tiers, component keys, and optional space filter.
 * @module src/backup/dto/backup-selection.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';

/** The four backup tiers. Files and identity default off — they are the expensive and risky ones. */
export class BackupTierSelectionDto {
  @ApiProperty({ default: true })
  @IsBoolean()
  content!: boolean;

  @ApiProperty({ default: true })
  @IsBoolean()
  configuration!: boolean;

  @ApiProperty({
    default: false,
    description: 'Attachments and storage objects. Dominates archive size.',
  })
  @IsBoolean()
  binary_files!: boolean;

  @ApiProperty({
    default: false,
    description: 'Users, memberships and permissions.',
  })
  @IsBoolean()
  identity!: boolean;
}

export class BackupSelectionDto {
  @ApiProperty({ type: BackupTierSelectionDto })
  @ValidateNested()
  @Type(() => BackupTierSelectionDto)
  tiers!: BackupTierSelectionDto;

  /** Registry component keys. Resolved against the registry by the service; unknown keys are a 400. */
  @ApiProperty({ type: [String], example: ['tasks', 'wiki', 'boards'] })
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(500)
  components!: string[];

  /** Empty means every space in the organization. */
  @ApiPropertyOptional({ type: [String], description: 'Empty = all spaces.' })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  @ArrayMaxSize(500)
  space_ids?: string[];
}
