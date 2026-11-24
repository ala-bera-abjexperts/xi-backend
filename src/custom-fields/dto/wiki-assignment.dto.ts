/**
 * @fileoverview DTOs for assigning field groups or standalone custom fields to
 * a space's wiki (Wiki 2.0). Uses an `assignment_type` discriminator, matching
 * the `wiki_field_assignments` table.
 * @module src/custom-fields/dto/wiki-assignment.dto
 * @author Prince Jadiya
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import type { AssignmentSection } from './assign-level.dto';

/** Payload for `POST /field-groups/wiki-assignments`. */
export class CreateWikiAssignmentDto {
  /** Accepted from body but ignored — organization comes from the auth token */
  @ApiPropertyOptional({ description: 'Ignored — org comes from auth token' })
  @IsOptional()
  @IsString()
  organizationId?: string;

  @ApiProperty({ description: 'Space the wiki assignment belongs to' })
  @IsUUID('4')
  space_id!: string;

  @ApiProperty({ enum: ['group', 'field'] })
  @IsIn(['group', 'field'])
  assignment_type!: 'group' | 'field';

  @ApiPropertyOptional({ description: 'Required when assignment_type=group' })
  @IsOptional()
  @IsUUID('4')
  field_group_id?: string;

  @ApiPropertyOptional({ description: 'Required when assignment_type=field' })
  @IsOptional()
  @IsUUID('4')
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

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_collapsed_default?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  show_in_header?: boolean;
}

/** Payload for `PATCH /field-groups/wiki-assignments/:id`. */
export class UpdateWikiAssignmentDto {
  /** Accepted from body but ignored — organization comes from the auth token */
  @ApiPropertyOptional({ description: 'Ignored — org comes from auth token' })
  @IsOptional()
  @IsString()
  organizationId?: string;

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

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_collapsed_default?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  show_in_header?: boolean;
}
