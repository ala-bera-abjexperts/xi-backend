/**
 * @fileoverview Request bodies for managing on-prem installations (partner
 * portal and super admin share them).
 * @module onprem-releases/dto/onprem-installations.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsObject, IsOptional, IsUUID } from 'class-validator';

export const ONPREM_MODES = ['connected', 'airgapped'] as const;
export type OnpremMode = (typeof ONPREM_MODES)[number];

export class CreateOnpremInstallDto {
  /** An on-prem licence (deployment_type = 'onprem') of the customer org. */
  @ApiProperty()
  @IsUUID()
  organization_license_id!: string;

  /** Partner customer record; derived from the licence when omitted. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  customer_id?: string;

  @ApiPropertyOptional({ enum: ONPREM_MODES, default: 'connected' })
  @IsOptional()
  @IsIn(ONPREM_MODES)
  mode?: OnpremMode;
}

/**
 * Only an operator decision can be changed by hand. Heartbeat, version and
 * usage come from the box's own check-ins and can no longer be edited (they
 * used to be, which let telemetry be forged).
 */
export class UpdateOnpremInstallDto {
  @ApiProperty({ enum: ['active', 'inactive'] })
  @IsIn(['active', 'inactive'])
  status!: 'active' | 'inactive';
}

export class OfflineLicenseDto {
  /** The signed licence-request file the box exported. */
  @ApiProperty({ type: Object })
  @IsObject()
  request!: Record<string, unknown>;
}
