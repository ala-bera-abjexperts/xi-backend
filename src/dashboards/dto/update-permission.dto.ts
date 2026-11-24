/**
 * @fileoverview DTO for updating a dashboard permission level.
 * @module src/dashboards/dto/update-permission.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsUUID } from 'class-validator';

export class UpdatePermissionDto {
  @ApiPropertyOptional({
    description: 'Accepted for legacy Next route compatibility; ignored.',
  })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiProperty({ enum: ['view', 'edit', 'manage'] })
  @IsIn(['view', 'edit', 'manage'])
  permission_level!: string;

  @ApiPropertyOptional({
    description: 'Accepted for legacy Next route compatibility.',
  })
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}
