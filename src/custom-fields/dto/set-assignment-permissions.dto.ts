/**
 * @fileoverview DTO for bulk setting permissions on a group-level assignment.
 * @module src/custom-fields/dto/set-assignment-permissions.dto
 * @author Prince Jadiya
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

/** Single permission entry in a bulk-set request. */
export class AssignmentPermissionDto {
  @ApiProperty({ enum: ['user', 'role', 'group', 'base_role'] })
  @IsIn(['user', 'role', 'group', 'base_role'])
  target_type!: 'user' | 'role' | 'group' | 'base_role';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  user_id?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  role_id?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  group_id?: string | null;

  @ApiPropertyOptional({ enum: ['owner', 'admin', 'member', 'viewer'] })
  @IsOptional()
  @IsIn(['owner', 'admin', 'member', 'viewer'])
  base_role?: 'owner' | 'admin' | 'member' | 'viewer' | null;

  @ApiProperty()
  @IsBoolean()
  can_view!: boolean;

  @ApiProperty()
  @IsBoolean()
  can_edit!: boolean;
}

/** Payload for `PUT /field-groups/:id/permissions`. */
export class SetAssignmentPermissionsDto {
  @ApiProperty({ type: [AssignmentPermissionDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AssignmentPermissionDto)
  permissions!: AssignmentPermissionDto[];
}
