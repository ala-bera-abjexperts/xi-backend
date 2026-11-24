/**
 * @fileoverview DTOs for workflow import + migration-helper endpoints.
 * The export doc / resolution are validated loosely (@IsObject) because their
 * deep shape is checked by WorkflowsImportExportService, not the pipe.
 * @module src/workflows/dto/import-workflow.dto
 * @author Rajbha Manek
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class ImportDryRunDto {
  @ApiProperty({ description: 'The workflow export document' })
  @IsObject()
  doc!: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Target space id (null = org-level)' })
  @IsOptional()
  @IsUUID()
  space_id?: string | null;
}

export class ImportConfirmDto {
  @ApiProperty({ description: 'The workflow export document' })
  @IsObject()
  doc!: Record<string, unknown>;

  @ApiProperty({
    description: 'Resolution choices (name, scope, auto-create, mappings)',
  })
  @IsObject()
  resolution!: Record<string, unknown>;
}

export class FromStatusesDto {
  @ApiProperty({
    description: 'Space whose task_status_transitions seed the workflow',
  })
  @IsUUID()
  space_id!: string;

  @ApiProperty({ description: 'Name for the generated workflow' })
  @IsString()
  @MaxLength(120)
  name!: string;
}
