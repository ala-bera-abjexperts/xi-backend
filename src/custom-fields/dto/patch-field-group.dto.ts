/**
 * @fileoverview DTO for `PATCH /field-groups/:id` action dispatcher
 * (restore, permanent_delete, duplicate).
 * @module src/custom-fields/dto/patch-field-group.dto
 * @author Prince Jadiya
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';

export type FieldGroupPatchAction =
  | 'restore'
  | 'permanent_delete'
  | 'duplicate';

/** Payload for `PATCH /field-groups/:id`. */
export class PatchFieldGroupDto {
  @ApiProperty({ enum: ['restore', 'permanent_delete', 'duplicate'] })
  @IsIn(['restore', 'permanent_delete', 'duplicate'])
  action!: FieldGroupPatchAction;

  @ApiPropertyOptional({ description: 'New group name for duplicate.' })
  @IsOptional()
  @IsString()
  newName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  organizationId?: string;

  @ApiPropertyOptional({
    description: 'When action=duplicate, copy field memberships.',
  })
  @IsOptional()
  @IsBoolean()
  copyFields?: boolean;
}
