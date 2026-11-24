/**
 * @fileoverview DTO for upserting organization branding configuration.
 * All fields are optional, allowing partial updates to the branding record.
 * @module src/organizations/dto/upsert-branding.dto
 * @author Prince Jadiya
 */

import { IsObject, IsOptional, IsString, IsUUID } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Data transfer object for creating or updating organization branding.
 *
 * All fields are optional; only provided fields will be written
 * to the `organization_branding` table.
 */
export class UpsertBrandingDto {
  /**
   * Legacy frontend compatibility only. The trusted organization is always
   * derived from the authenticated user context.
   */
  @ApiPropertyOptional({
    description:
      'Legacy compatibility field. Ignored; organization is derived from auth context.',
  })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  /** Primary brand color (e.g. '#3B82F6') */
  @ApiPropertyOptional({
    example: '#3B82F6',
    description: 'Primary brand color hex code',
  })
  @IsOptional()
  @IsString()
  primary_color?: string | null;

  /** Public URL for the light-mode logo */
  @ApiPropertyOptional({ description: 'Public URL for the light-mode logo' })
  @IsOptional()
  @IsString()
  logo_light_url?: string | null;

  /** Storage path for the light-mode logo */
  @ApiPropertyOptional({ description: 'Storage path for the light-mode logo' })
  @IsOptional()
  @IsString()
  logo_light_path?: string | null;

  /** Public URL for the dark-mode logo */
  @ApiPropertyOptional({ description: 'Public URL for the dark-mode logo' })
  @IsOptional()
  @IsString()
  logo_dark_url?: string | null;

  /** Storage path for the dark-mode logo */
  @ApiPropertyOptional({ description: 'Storage path for the dark-mode logo' })
  @IsOptional()
  @IsString()
  logo_dark_path?: string | null;

  /** Public URL for the light-mode emblem */
  @ApiPropertyOptional({ description: 'Public URL for the light-mode emblem' })
  @IsOptional()
  @IsString()
  emblem_light_url?: string | null;

  /** Storage path for the light-mode emblem */
  @ApiPropertyOptional({
    description: 'Storage path for the light-mode emblem',
  })
  @IsOptional()
  @IsString()
  emblem_light_path?: string | null;

  /** Public URL for the dark-mode emblem */
  @ApiPropertyOptional({ description: 'Public URL for the dark-mode emblem' })
  @IsOptional()
  @IsString()
  emblem_dark_url?: string | null;

  /** Storage path for the dark-mode emblem */
  @ApiPropertyOptional({ description: 'Storage path for the dark-mode emblem' })
  @IsOptional()
  @IsString()
  emblem_dark_path?: string | null;
}

/**
 * Per-surface theme: backgrounds and typography for the app shell and the wiki.
 *
 * Deliberately NOT a field on `UpsertBrandingDto`. That endpoint is ungated so existing
 * tenants keep their logo and primary colour regardless of plan; putting `theme_config`
 * there would hand every plan the licensed feature through the back door. It lives on its
 * own DTO behind its own `feature_custom_branding` route instead, and `forbidNonWhitelisted`
 * makes the separation real — sending it to the ungated route is a 400, not a silent write.
 *
 * The shape is owned by the frontend Zod schema (`branding-theme.model.ts`) and re-validated
 * there on read, so this only asserts "is an object" — the approach the asset DTOs take.
 */
export class UpsertBrandingThemeDto {
  @ApiPropertyOptional({
    description:
      'Per-surface branding theme (backgrounds + typography for app shell and wiki)',
  })
  @IsObject()
  theme_config!: Record<string, unknown>;
}
