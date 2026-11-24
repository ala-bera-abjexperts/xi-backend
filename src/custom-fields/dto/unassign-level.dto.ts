/**
 * @fileoverview DTO for removing a level assignment (group or field).
 * @module src/custom-fields/dto/unassign-level.dto
 * @author Prince Jadiya
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import type { AssignmentEntityType } from './assign-level.dto';

/** Payload for `DELETE /field-groups/level-assignments`. */
export class UnassignLevelDto {
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

  @ApiPropertyOptional({
    description: 'Required when type=group.',
  })
  @IsOptional()
  @IsString()
  field_group_id?: string;

  @ApiPropertyOptional({
    description: 'Required when type=field.',
  })
  @IsOptional()
  @IsString()
  custom_field_id?: string;
}
