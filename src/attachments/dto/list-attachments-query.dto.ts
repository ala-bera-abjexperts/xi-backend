import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID } from 'class-validator';

export const ATTACHMENT_ENTITY_TYPES = [
  'task',
  'process',
  'wiki_page',
  'asset_item',
  'space_gdpr_record',
  'support_request',
  'asset_object',
  // Chat message files: access is resolved by ChatAccessService, not by a space permission.
  'chat_message',
  // Test Management evidence: access is resolved by TestManagementAttachmentAccessService.
  'test_case',
  'test_run_attempt',
  'test_execution',
  'test_step',
] as const;

export type AttachmentEntityType = (typeof ATTACHMENT_ENTITY_TYPES)[number];

/** Entity types whose access is a row lookup + space permission (everything but chat). */
export type SpaceAttachmentEntityType = Exclude<
  AttachmentEntityType,
  | 'chat_message'
  | 'test_case'
  | 'test_run_attempt'
  | 'test_execution'
  | 'test_step'
>;

export class ListAttachmentsQueryDto {
  @ApiProperty({ enum: ATTACHMENT_ENTITY_TYPES })
  @IsIn(ATTACHMENT_ENTITY_TYPES)
  entityType!: AttachmentEntityType;

  @ApiProperty()
  @IsUUID()
  entityId!: string;

  @ApiPropertyOptional({
    description:
      'Accepted for legacy frontend compatibility only. The backend resolves the trusted space from the parent entity.',
  })
  @IsOptional()
  @IsUUID()
  spaceId?: string;
}
