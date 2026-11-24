/**
 * @fileoverview DTO for creating a business process.
 * @module src/processes/dto/create-process.dto
 * @author Prince Jadiya
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export const REQUEST_TYPES = [
  'Risiko',
  'Geschäftsprozessbewertung',
  'Prozessbewertung',
  'Servicebewertung',
  'Assetbewertung',
  'Schwachstelle',
  'Maßnahme',
  'Assetgroup',
] as const;

export const PROCESS_STATUSES = [
  'active',
  'inactive',
  'archived',
  'draft',
] as const;

export class CreateProcessDto {
  @ApiProperty({ description: 'Space this process belongs to' })
  @IsUUID()
  space_id!: string;

  @ApiProperty({ example: 'IT Security Risk Assessment', maxLength: 200 })
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  title!: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiProperty({ enum: REQUEST_TYPES })
  @IsString()
  @IsIn(REQUEST_TYPES as unknown as string[])
  request_type!: (typeof REQUEST_TYPES)[number];

  @ApiPropertyOptional({ enum: PROCESS_STATUSES, default: 'active' })
  @IsOptional()
  @IsString()
  @IsIn(PROCESS_STATUSES as unknown as string[])
  status?: (typeof PROCESS_STATUSES)[number];

  @ApiPropertyOptional({
    description: 'Hierarchy level ID from hierarchy-config',
  })
  @IsOptional()
  @IsString()
  hierarchy_level_id?: string;

  @ApiPropertyOptional({
    description: 'Parent process UUIDs (multi-parent)',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  parent_ids?: string[];

  @ApiPropertyOptional({
    description: 'Legacy single parent process UUID',
  })
  @IsOptional()
  @IsUUID()
  parent_id?: string;

  @ApiPropertyOptional({ description: 'UUID of owner/assignee' })
  @IsOptional()
  @IsUUID()
  assigned_to?: string;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;

  // Vulnerability ratings (Schwachstelle) - 0-4
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(4)
  vuln_c_p?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(4)
  vuln_c_i?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(4)
  vuln_i_p?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(4)
  vuln_i_i?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(4)
  vuln_a_p?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(4)
  vuln_a_i?: number;

  // Action ratings (Maßnahme) - 0-4
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(4)
  action_c_p?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(4)
  action_c_i?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(4)
  action_i_p?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(4)
  action_i_i?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(4)
  action_a_p?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(4)
  action_a_i?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  custom_field_values?: Record<string, unknown>;
}
