import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { DOCUMENT_SOURCE_ENTITIES } from '../source-entities';
import type { DocumentSourceEntity } from '../template-definition/template-definition.types';

export class UpdateDocumentTemplateDto {
  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @ApiPropertyOptional({ enum: DOCUMENT_SOURCE_ENTITIES })
  @IsOptional()
  @IsIn(DOCUMENT_SOURCE_ENTITIES)
  source_entity?: DocumentSourceEntity;

  @ApiPropertyOptional({ enum: ['repeat_per_item', 'fixed_document'] })
  @IsOptional()
  @IsIn(['repeat_per_item', 'fixed_document'])
  mode?: 'repeat_per_item' | 'fixed_document';

  @ApiPropertyOptional({
    type: Object,
    description:
      'Template definition JSON; re-validated by the service when present.',
  })
  @IsOptional()
  @IsObject()
  definition?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_archived?: boolean;
}
