import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsUUID } from 'class-validator';
import {
  ATTACHMENT_ENTITY_TYPES,
  type AttachmentEntityType,
} from './list-attachments-query.dto';

export class CreateEntityFileLinkDto {
  @ApiProperty({ enum: ATTACHMENT_ENTITY_TYPES })
  @IsIn(ATTACHMENT_ENTITY_TYPES)
  entity_type!: AttachmentEntityType;

  @ApiProperty()
  @IsUUID()
  entity_id!: string;

  @ApiProperty()
  @IsUUID()
  node_id!: string;
}
