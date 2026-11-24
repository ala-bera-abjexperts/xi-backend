/**
 * @fileoverview DTO for updating a GDPR record (optimistic locking via version).
 * @module src/gdpr/dto/update-record.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsUUID,
  Min,
} from 'class-validator';

export class UpdateRecordDto {
  @ApiPropertyOptional({
    description: 'Legacy body record UUID. Route param remains authoritative.',
  })
  @IsOptional()
  @IsUUID()
  id?: string;

  @ApiPropertyOptional({
    description:
      'Compatibility organization ID. Ignored; auth context is trusted.',
  })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiPropertyOptional({ description: 'Cell data as key-value pairs' })
  @IsOptional()
  @IsObject()
  cell_data?: Record<string, unknown>;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  row_order?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_archived?: boolean;

  @ApiPropertyOptional({
    description: 'Assigned user UUID or null to unassign',
  })
  @IsOptional()
  @IsUUID()
  assignee_id?: string | null;

  @ApiProperty({
    description: 'Current record version for optimistic locking',
    minimum: 1,
  })
  @IsInt()
  @Min(1)
  version!: number;
}
