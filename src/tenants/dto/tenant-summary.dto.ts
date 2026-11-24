/**
 * @fileoverview Response DTO for tenant endpoints. One row per organization the
 * authenticated user is a member of, denormalised so the tenant switcher UI can
 * render chips without an additional fetch.
 * @module src/tenants/dto/tenant-summary.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class TenantSummaryDto {
  @ApiProperty({ description: 'Organization UUID' })
  organizationId!: string;

  @ApiProperty({
    description: 'URL slug used in `/spaces/<slug>` style routes',
  })
  slug!: string;

  @ApiProperty({ description: 'Organization display name' })
  name!: string;

  @ApiProperty({
    description: 'Caller role in this org',
    enum: ['owner', 'admin', 'member', 'viewer'],
  })
  role!: 'owner' | 'admin' | 'member' | 'viewer';

  @ApiPropertyOptional({
    description:
      'Approximate member count for the switcher UI. Omitted when not yet computed.',
  })
  memberCount?: number;

  @ApiPropertyOptional({
    description:
      'Logo URL for the tenant chip. Sourced from organization_branding.logo_light_url — there is no generic `logo_url` column on this schema.',
    nullable: true,
  })
  iconUrl?: string | null;

  @ApiPropertyOptional({
    description: 'Brand primary color hex string.',
    nullable: true,
  })
  primaryColor?: string | null;

  @ApiProperty({
    description:
      'ISO timestamp from organization_members.created_at — when the caller joined this org.',
  })
  joinedAt!: string;
}
