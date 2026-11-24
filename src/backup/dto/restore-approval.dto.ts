/**
 * @fileoverview Bodies for asking another organization to accept a restore, and for deciding one.
 * @module src/backup/dto/restore-approval
 *
 * `target_organization_id` IS a tenant id in a request body, which the rest of this module refuses
 * on principle. It is safe here for a reason worth stating: it names the organization being ASKED,
 * and a database trigger requires the requester to be a member of it before the row may exist. The
 * worst a caller achieves by naming an organization they do not belong to is their own request
 * being rejected — it grants nothing, and it cannot be used to discover whether an organization
 * exists, because the answer is the same either way.
 *
 * The space is split into two fields on purpose. A same-org restore uses `source_space_id` to mean
 * "only rows already in this space". A cross-org restore uses `destination_space_id` to mean "put
 * everything here". Those are different questions, and the single `space_id` that tried to be both
 * is what silently discarded 124 rows: it was filled with a space from the organization being
 * restored INTO, which no archived row could ever match.
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

/** Table names the registry can contain — `assertSafeIdentifier` guarantees this shape. */
const TABLE_NAME = /^[a-z0-9_]+$/;

export class CreateRestoreApprovalRequestDto {
  @ApiProperty({
    description:
      'The organization being asked to accept the restore. You must belong to it.',
  })
  @IsUUID()
  target_organization_id!: string;

  @ApiProperty({ description: 'The target the archive lives on.' })
  @IsUUID()
  target_id!: string;

  @ApiProperty({ description: 'The archive to restore from.' })
  @IsUUID()
  artifact_id!: string;

  @ApiProperty({
    description:
      'Tables to restore. The approval covers exactly these — a later restore of anything else ' +
      'needs its own request.',
    type: [String],
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(300)
  @IsString({ each: true })
  @Matches(TABLE_NAME, {
    each: true,
    message:
      'A table name may contain only lowercase letters, digits and underscores.',
  })
  tables!: string[];

  @ApiPropertyOptional({
    description:
      'Restore only rows that were in this space in the ARCHIVE. Omit for every space.',
  })
  @IsOptional()
  @IsUUID()
  source_space_id?: string;

  @ApiPropertyOptional({
    description:
      'The space in the target organization the rows should land in. Required when the target ' +
      'organization is not your own, because archived rows carry the source space and it does not ' +
      'exist there.',
  })
  @IsOptional()
  @IsUUID()
  destination_space_id?: string;

  @ApiPropertyOptional({
    description:
      'Ask the approving owner to also accept identity rows (roles, memberships, invitations, preferences). Defaults false.',
  })
  @IsOptional()
  @IsBoolean()
  include_identity?: boolean;

  @ApiPropertyOptional({
    description: 'A note for the approver explaining what this restore is for.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class DecideRestoreApprovalDto {
  @ApiPropertyOptional({
    description:
      'Why it was approved or rejected. Shown to the requester alongside the decision.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
