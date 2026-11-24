import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { DOCUMENT_SOURCE_ENTITIES } from '../source-entities';
import type { DocumentSourceEntity } from '../template-definition/template-definition.types';

export class CreateDocumentTemplateDto {
  @ApiProperty({ maxLength: 200, example: 'Task Status Report' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @ApiProperty({ enum: DOCUMENT_SOURCE_ENTITIES })
  @IsIn(DOCUMENT_SOURCE_ENTITIES)
  source_entity!: DocumentSourceEntity;

  @ApiProperty({ enum: ['repeat_per_item', 'fixed_document'] })
  @IsIn(['repeat_per_item', 'fixed_document'])
  mode!: 'repeat_per_item' | 'fixed_document';

  @ApiProperty({
    type: Object,
    description:
      'Template definition JSON (schemaVersion 1); deep-validated by the service against the zod contract.',
  })
  @IsObject()
  definition!: Record<string, unknown>;
}
