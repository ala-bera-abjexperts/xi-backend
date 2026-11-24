/**
 * @fileoverview Non-secret SharePoint Online / Microsoft Graph connection shape.
 * @module src/backup/dto/sharepoint-target-config.dto
 *
 * Accepted and stored now so a target row is complete, but no Graph adapter exists yet — a
 * SharePoint target cannot be exercised until the Graph adapter ships. tenant_id and client_id are
 * duplicated in the encrypted secret bundle on purpose: these are the non-secret copies used for
 * display and diagnostics, so the UI never has to decrypt anything to render a target card.
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class SharePointTargetConfigDto {
  @ApiProperty({ description: 'Entra (Azure AD) tenant id' })
  @IsUUID()
  tenant_id!: string;

  @ApiProperty({ description: 'App registration client id' })
  @IsUUID()
  client_id!: string;

  @ApiProperty({ description: 'Graph site id the library belongs to' })
  @IsString()
  @MaxLength(512)
  site_id!: string;

  @ApiProperty({ description: 'Graph drive id of the document library' })
  @IsString()
  @MaxLength(512)
  drive_id!: string;

  @ApiProperty({
    description: 'Folder path within the library the archive is written into',
  })
  @IsString()
  @MaxLength(1024)
  folder_path!: string;

  @ApiPropertyOptional({
    description:
      'Graph scope requested for the token. Defaults to the app-only default scope.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  graph_scope?: string;
}
