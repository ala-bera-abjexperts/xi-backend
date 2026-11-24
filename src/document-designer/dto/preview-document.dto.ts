import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsObject, IsOptional, Max, Min } from 'class-validator';

export class PreviewDocumentDto {
  @ApiPropertyOptional({
    type: Object,
    description:
      'Template definition to preview. Required for POST /preview; ignored for POST /:id/preview (the stored definition is used).',
  })
  @IsOptional()
  @IsObject()
  definition?: Record<string, unknown>;

  @ApiPropertyOptional({
    type: Object,
    description:
      'Item scope: { savedFilterId } | { query, source_space_ids } | { ids }. Defaults to the first permitted items of the entity.',
  })
  @IsOptional()
  @IsObject()
  scope?: Record<string, unknown>;

  @ApiPropertyOptional({ minimum: 1, maximum: 20, default: 3 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  itemLimit?: number;
}
