import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import {
  ATTACHMENT_ENTITY_TYPES,
  type AttachmentEntityType,
} from './list-attachments-query.dto';

export class UploadAttachmentDto {
  @ApiProperty({ enum: ATTACHMENT_ENTITY_TYPES })
  @IsIn(ATTACHMENT_ENTITY_TYPES)
  entity_type!: AttachmentEntityType;

  @ApiProperty()
  @IsUUID()
  entity_id!: string;

  @ApiPropertyOptional({
    description:
      'Accepted for legacy frontend compatibility only. The backend resolves the trusted space from the parent entity.',
  })
  @IsOptional()
  @IsUUID()
  space_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;
}
