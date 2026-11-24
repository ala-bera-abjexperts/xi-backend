import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class ExportDocumentDto {
  @ApiProperty({ enum: ['pdf', 'docx', 'html'] })
  @IsIn(['pdf', 'docx', 'html'])
  format!: 'pdf' | 'docx' | 'html';

  @ApiProperty({
    type: Object,
    description:
      'Item scope — exactly one of { savedFilterId } | { ids } | { query, source_space_ids } (validated in the service).',
  })
  @IsObject()
  scope!: Record<string, unknown>;

  @ApiPropertyOptional({ enum: ['download', 'store'], default: 'download' })
  @IsOptional()
  @IsIn(['download', 'store'])
  delivery?: 'download' | 'store';

  @ApiPropertyOptional({
    description: 'File name without extension (sanitized server-side).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  fileName?: string;
}
