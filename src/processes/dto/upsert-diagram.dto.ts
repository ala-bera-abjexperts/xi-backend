/**
 * @fileoverview DTO for upserting a process diagram.
 * Matches risk-management-app PUT /spaces/:id/processes/:processId/diagram.
 * @module src/processes/dto/upsert-diagram.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class UpsertDiagramDto {
  @ApiProperty({ description: 'draw.io XML content for the diagram' })
  @IsString()
  @IsNotEmpty()
  xml!: string;

  @ApiPropertyOptional({ description: 'SVG preview string' })
  @IsOptional()
  @IsString()
  previewSvg?: string;
}
