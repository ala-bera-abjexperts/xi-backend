/**
 * @fileoverview Request DTO for `POST /tenants/switch`. Accepts EITHER an
 * organization UUID OR a slug — exactly one. The XOR rule cannot be expressed
 * cleanly in class-validator decorators, so the service layer enforces it.
 * @module src/tenants/dto/switch-tenant.dto
 */

import { IsOptional, IsString, IsUUID, Matches } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class SwitchTenantDto {
  @ApiPropertyOptional({
    description:
      'Target organization UUID. Mutually exclusive with `slug`. Exactly one of the two must be provided.',
  })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiPropertyOptional({
    description:
      'Target organization slug. Mutually exclusive with `organizationId`.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9-]+$/, {
    message: 'slug must contain only lowercase letters, numbers, and hyphens',
  })
  slug?: string;
}
