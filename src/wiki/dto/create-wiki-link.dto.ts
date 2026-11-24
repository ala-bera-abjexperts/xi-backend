/**
 * @fileoverview DTO for creating a wiki page link to an entity.
 * @module src/wiki/dto/create-wiki-link.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsObject, IsOptional, IsUUID } from 'class-validator';

export class CreateWikiLinkDto {
  @ApiProperty({ enum: ['page', 'process', 'task', 'asset', 'list'] })
  @IsIn(['page', 'process', 'task', 'asset', 'list'])
  target_type!: string;

  @ApiProperty({ description: 'UUID of the linked entity' })
  @IsUUID()
  target_id!: string;

  @ApiPropertyOptional({ description: 'Optional contextual metadata' })
  @IsOptional()
  @IsObject()
  target_metadata?: Record<string, unknown>;
}
