import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsUUID,
} from 'class-validator';

/** Largest id batch per bulk request; the list view sends bigger selections in chunks. */
export const MAX_BULK_TEMPLATE_IDS = 200;

export class BulkDocumentTemplateIdsDto {
  @ApiProperty({ type: [String], maxItems: MAX_BULK_TEMPLATE_IDS })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_BULK_TEMPLATE_IDS)
  @IsUUID('all', { each: true })
  ids!: string[];
}

export class BulkUpdateDocumentTemplatesDto extends BulkDocumentTemplateIdsDto {
  @ApiProperty({ description: 'true archives, false restores.' })
  @IsBoolean()
  is_archived!: boolean;
}
