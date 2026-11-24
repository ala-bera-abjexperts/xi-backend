/**
 * @fileoverview DTO for granting a dashboard permission.
 * @module src/dashboards/dto/create-permission.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';

const TARGET_TYPES = ['user', 'group', 'role', 'base_role'] as const;
const PERMISSION_LEVELS = ['view', 'edit', 'manage'] as const;
const BASE_ROLES = ['owner', 'admin', 'member', 'viewer'] as const;

export class CreatePermissionDto {
  @ApiPropertyOptional({
    description: 'Accepted for legacy Next route compatibility; ignored.',
  })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiProperty({ enum: TARGET_TYPES })
  @IsIn(TARGET_TYPES)
  target_type!: string;

  @ApiPropertyOptional({
    description: 'Target UUID — required when target_type is user|group|role',
  })
  @IsOptional()
  @IsUUID()
  target_id?: string;

  @ApiPropertyOptional({
    enum: BASE_ROLES,
    description: 'Required when target_type is base_role',
  })
  @IsOptional()
  @IsString()
  @IsIn(BASE_ROLES)
  base_role?: string;

  @ApiProperty({ enum: PERMISSION_LEVELS })
  @IsIn(PERMISSION_LEVELS)
  permission_level!: string;
}
