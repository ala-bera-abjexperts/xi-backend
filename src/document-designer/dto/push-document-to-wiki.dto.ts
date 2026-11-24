/**
 * @fileoverview DTOs for pushing a document template's rendered output into
 * a wiki page. `space_id` is snake_case so SpacePermissionsGuard's
 * `body.space_id` fallback resolves it (routes use `:templateId`, not
 * `:id`, so the guard's `params.id` fallback never shadows it).
 * @module src/document-designer/dto/push-document-to-wiki.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class PushDocumentToWikiDto {
  @ApiProperty({ description: 'Target wiki space' })
  @IsUUID()
  space_id!: string;

  @ApiProperty({
    type: Object,
    description: 'Item scope — same shape as ExportDocumentDto.scope.',
  })
  @IsObject()
  scope!: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Optional parent wiki page UUID' })
  @IsOptional()
  @IsUUID()
  parent_id?: string;

  @ApiPropertyOptional({ description: 'Defaults to the template name' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  title?: string;
}

export class UpdateWikiPushDto {
  @ApiProperty({ description: 'Space the target page belongs to' })
  @IsUUID()
  space_id!: string;

  @ApiProperty({ type: Object })
  @IsObject()
  scope!: Record<string, unknown>;

  @ApiPropertyOptional({
    description:
      'Confirms overwriting a page that was hand-edited since the last push, or that has open comments.',
  })
  @IsOptional()
  @IsBoolean()
  confirmed?: boolean;
}
