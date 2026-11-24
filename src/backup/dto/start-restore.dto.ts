/**
 * @fileoverview Bodies for previewing and applying a restore.
 * @module src/backup/dto/start-restore.dto
 *
 * Both classes have to exist even where every field is optional: the global ValidationPipe runs with
 * `whitelist` and `forbidNonWhitelisted`, so a POST carrying a key no DTO declares is a 400.
 *
 * The passphrase travels in the body, never the URL — a query parameter would be written to browser
 * history, proxy logs, the referrer header and every access log in between. It is not stored, which
 * is why apply asks for it again rather than reusing the preview's.
 *
 * The organization the restore writes into is NEVER a field here. It is resolved from the session,
 * because a body-supplied tenant id is a tenant boundary the caller gets to choose.
 *
 * `expected_organization_id` is not an exception to that. It is the organization the OPERATOR
 * believes they are restoring into, and the only thing the server does with it is compare it to the
 * session and refuse when they differ. It can never select, widen or grant anything — the worst a
 * caller achieves by sending someone else's tenant id is their own request being rejected. It exists
 * because the wizard lets an operator pick an organization, and a pick that silently does nothing is
 * how a restore came to report success over zero rows written.
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

export class StartRestoreDryRunDto {
  @ApiProperty({ description: 'The target the archive lives on.' })
  @IsUUID()
  target_id!: string;

  @ApiProperty({ description: 'The archive to restore from.' })
  @IsUUID()
  artifact_id!: string;

  @ApiProperty({
    description:
      'Tables to restore. The backend may add required parent tables from the same archive so ' +
      'relation rows can be restored safely.',
    type: [String],
  })
  @IsArray()
  @ArrayNotEmpty()
  // The registry holds 176 tables, so anything beyond that is not a selection.
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
      'Where to write. Omit for this instance and this organization, which is what a restore ' +
      'did before destinations existed.',
  })
  @IsOptional()
  @IsUUID()
  destination_id?: string;

  @ApiPropertyOptional({
    description:
      'The organization the caller believes this restore writes into. Compared against the ' +
      'session and refused when it differs; it never selects where the rows go. Omit to accept ' +
      'whichever organization the session is in.',
  })
  @IsOptional()
  @IsUUID()
  expected_organization_id?: string;

  @ApiPropertyOptional({
    description:
      'Restore only rows belonging to this space. Tables that are not space-scoped are ' +
      'unaffected — they have no space column to compare. Must be a space of the organization ' +
      'being restored into.',
  })
  @IsOptional()
  @IsUUID()
  space_id?: string;

  @ApiPropertyOptional({
    description:
      'The space in the target organization the rows land in. Only meaningful when restoring into ' +
      'another organization, where the archived space belongs to a tenant the destination knows ' +
      'nothing about. Must match what was approved.',
  })
  @IsOptional()
  @IsUUID()
  destination_space_id?: string;

  @ApiPropertyOptional({
    description:
      "The scheme's archive passphrase. Required for an encrypted archive, ignored for a plain one.",
  })
  @IsOptional()
  @IsString()
  // Bounded so an oversized body cannot force an expensive scrypt derivation.
  @MaxLength(1024)
  passphrase?: string;

  @ApiPropertyOptional({
    description:
      'Restore identity-tier tables too — roles, memberships, invitations, groups, service ' +
      'principals and user preferences. Requires can_restore_identity, and is refused without it. ' +
      'Omit for the default, which restores no identity data at all.',
  })
  @IsOptional()
  @IsBoolean()
  include_identity?: boolean;

  @ApiPropertyOptional({
    description:
      "Let per-space configuration in the archive REPLACE the destination's own. Restoring a " +
      'many-space organization into a smaller one folds several source spaces onto one ' +
      'destination space, and only one configuration can occupy it — by default the ' +
      'destination keeps its own and the rest are reported as folded. Turning this on overwrites ' +
      'it instead, which is the only way those rows come back. Omit for the default, which ' +
      'changes nothing that is already there.',
  })
  @IsOptional()
  @IsBoolean()
  replace_existing_config?: boolean;
}

export class ApplyRestoreDto {
  @ApiPropertyOptional({
    description:
      'The archive passphrase again. It is never stored, so it is needed a second time to apply.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  passphrase?: string;
}
