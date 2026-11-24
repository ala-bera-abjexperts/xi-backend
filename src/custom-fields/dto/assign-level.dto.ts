/**
 * @fileoverview DTOs for assigning field groups or standalone fields to a
 * hierarchy level. Uses a `type` discriminator.
 * @module src/custom-fields/dto/assign-level.dto
 * @author Prince Jadiya
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export type AssignmentEntityType = 'process' | 'task' | 'list_item';
export type AssignmentSection = 'header' | 'main' | 'footer' | 'sidebar';

/** Payload for assigning an entire field group to a level. */
export class AssignGroupToLevelDto {
  @ApiProperty({ enum: ['group'] })
  @IsIn(['group'])
  type!: 'group';

  @ApiProperty()
  @IsString()
  hierarchy_level_id!: string;

  @ApiProperty({ enum: ['process', 'task', 'list_item'] })
  @IsIn(['process', 'task', 'list_item'])
  entity_type!: AssignmentEntityType;

  @ApiProperty()
  @IsString()
  field_group_id!: string;

  @ApiPropertyOptional({ enum: ['header', 'main', 'footer', 'sidebar'] })
  @IsOptional()
  @IsIn(['header', 'main', 'footer', 'sidebar'])
  section?: AssignmentSection;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  sort_order?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_collapsed_default?: boolean;
}

/** Payload for assigning a single standalone field to a level. */
export class AssignFieldToLevelDto {
  @ApiProperty({ enum: ['field'] })
  @IsIn(['field'])
  type!: 'field';

  @ApiProperty()
  @IsString()
  hierarchy_level_id!: string;

  @ApiProperty({ enum: ['process', 'task', 'list_item'] })
  @IsIn(['process', 'task', 'list_item'])
  entity_type!: AssignmentEntityType;

  @ApiProperty()
  @IsString()
  custom_field_id!: string;

  @ApiPropertyOptional({ enum: ['header', 'main', 'footer', 'sidebar'] })
  @IsOptional()
  @IsIn(['header', 'main', 'footer', 'sidebar'])
  section?: AssignmentSection;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  sort_order?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_required?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_hidden?: boolean;

  @ApiPropertyOptional({ minimum: 1, maximum: 12 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  column_span?: number;
}

/**
 * Unified class passed to `POST /field-groups/level-assignments`.
 * Uses a `type` discriminator. The controller dispatches to the appropriate
 * service method based on `type`. Fields specific to each branch are optional
 * at the DTO level but enforced by the controller at runtime.
 */
export class AssignLevelDto {
  @ApiPropertyOptional({ description: 'Ignored — org comes from auth token' })
  @IsOptional()
  @IsString()
  organizationId?: string;

  @ApiProperty({ enum: ['group', 'field'] })
  @IsIn(['group', 'field'])
  type!: 'group' | 'field';

  @ApiProperty()
  @IsString()
  hierarchy_level_id!: string;

  @ApiProperty({ enum: ['process', 'task', 'list_item'] })
  @IsIn(['process', 'task', 'list_item'])
  entity_type!: AssignmentEntityType;

  @ApiPropertyOptional({ description: 'Required when type=group' })
  @IsOptional()
  @IsString()
  field_group_id?: string;

  @ApiPropertyOptional({ description: 'Required when type=field' })
  @IsOptional()
  @IsString()
  custom_field_id?: string;

  @ApiPropertyOptional({ enum: ['header', 'main', 'footer', 'sidebar'] })
  @IsOptional()
  @IsIn(['header', 'main', 'footer', 'sidebar'])
  section?: AssignmentSection;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_collapsed_default?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_required?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_hidden?: boolean;

  @ApiPropertyOptional({ minimum: 1, maximum: 12 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  column_span?: number;
}
