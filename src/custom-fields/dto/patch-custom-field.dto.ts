/**
 * @fileoverview DTO for `PATCH /custom-fields/:id` — drives the action
 * dispatcher (toggle_active, restore, permanent_delete).
 * @module src/custom-fields/dto/patch-custom-field.dto
 * @author Prince Jadiya
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';

export type CustomFieldPatchAction =
  | 'toggle_active'
  | 'restore'
  | 'permanent_delete';

/** Payload for `PATCH /custom-fields/:id`. */
export class PatchCustomFieldDto {
  @ApiProperty({
    enum: ['toggle_active', 'restore', 'permanent_delete'],
  })
  @IsIn(['toggle_active', 'restore', 'permanent_delete'])
  action!: CustomFieldPatchAction;

  @ApiPropertyOptional({
    description:
      'Required when action is `toggle_active`; new `is_active` value.',
  })
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}
