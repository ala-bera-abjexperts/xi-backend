/**
 * @fileoverview DTO for publish/unpublish wiki page action.
 * @module src/wiki/dto/publish-wiki-page.dto
 */

import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class PublishWikiPageDto {
  @ApiProperty({ description: 'true to publish, false to unpublish' })
  @IsBoolean()
  publish!: boolean;
}
