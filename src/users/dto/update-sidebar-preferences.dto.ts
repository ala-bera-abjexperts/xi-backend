/**
 * @fileoverview DTO for updating sidebar preferences. All properties are optional,
 * allowing partial updates to the user's sidebar configuration stored as JSONB
 * in the `user_sidebar_preferences` table.
 * @module src/users/dto/update-sidebar-preferences.dto
 * @author Prince Jadiya
 */

import {
  IsOptional,
  IsArray,
  IsBoolean,
  IsInt,
  Min,
  Max,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Data transfer object for the PATCH /users/sidebar-preferences endpoint.
 *
 * All fields are optional; the provided fields are merged into the existing
 * sidebar config JSONB column. Field names match the frontend ISidebarConfig
 * camelCase contract exactly.
 */
export class UpdateSidebarPreferencesDto {
  /** Sidebar sections with visibility and order */
  @ApiPropertyOptional({
    example: [{ id: 'spaces', visible: true, order: 0 }],
    description: 'Sidebar sections with id, visible flag, and order',
  })
  @IsOptional()
  @IsArray()
  sections?: Record<string, unknown>[];

  /** External links to display in the sidebar */
  @ApiPropertyOptional({
    example: [{ id: 'uuid', name: 'Docs', url: 'https://docs.example.com' }],
    description: 'External links displayed in the sidebar',
  })
  @IsOptional()
  @IsArray()
  externalLinks?: Record<string, unknown>[];

  /** Whether the spaces section is expanded */
  @ApiPropertyOptional({
    example: true,
    description: 'Whether the spaces section is expanded',
  })
  @IsOptional()
  @IsBoolean()
  spacesExpanded?: boolean;

  /** Number of recent items to display in the sidebar */
  @ApiPropertyOptional({
    example: 10,
    description: 'Number of recent items to display (5–30)',
  })
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(30)
  recentItemsCount?: number;
}
