/**
 * @fileoverview DTO for querying/filtering GDPR records.
 * @module src/gdpr/dto/list-records-query.dto
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class ListRecordsQueryDto {
  @ApiPropertyOptional({
    description:
      'Compatibility organization ID. Ignored; auth context is trusted.',
  })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiPropertyOptional({ description: 'Compatibility spreadsheet UUID filter' })
  @IsOptional()
  @IsUUID()
  spreadsheet_id?: string;

  @ApiPropertyOptional({
    description: "Filter by archive state ('true' or 'false')",
  })
  @IsOptional()
  @IsString()
  is_archived?: string;

  @ApiPropertyOptional({ description: 'Full-text search term', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ description: 'Page number (1-based)' })
  @IsOptional()
  @IsString()
  page?: string;

  @ApiPropertyOptional({ description: 'Page size (max 200)' })
  @IsOptional()
  @IsString()
  pageSize?: string;

  @ApiPropertyOptional({ description: 'Legacy snake_case page size alias' })
  @IsOptional()
  @IsString()
  page_size?: string;

  @ApiPropertyOptional({ description: 'Filter by assignee UUID' })
  @IsOptional()
  @IsUUID()
  assignee_id?: string;

  @ApiPropertyOptional({ description: 'JSON encoded column filter map' })
  @IsOptional()
  @IsString()
  column_filters?: string;
}
