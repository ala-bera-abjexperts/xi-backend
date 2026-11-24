/**
 * @fileoverview DTO for PATCH dashboard — action-based dispatch.
 * @module src/dashboards/dto/patch-dashboard.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID } from 'class-validator';

export class PatchDashboardDto {
  @ApiPropertyOptional({
    description: 'Accepted for legacy Next route compatibility; ignored.',
  })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiProperty({
    enum: ['set_default', 'archive'],
    description: 'Action to perform',
  })
  @IsIn(['set_default', 'archive'])
  action!: 'set_default' | 'archive';
}
