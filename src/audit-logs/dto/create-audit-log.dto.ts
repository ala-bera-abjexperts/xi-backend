/**
 * @fileoverview DTO for creating an audit log entry.
 * @module src/audit-logs/dto/create-audit-log.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

const AUDIT_ACTIONS = [
  'create',
  'update',
  'delete',
  'calculate',
  'archive',
  'restore',
  // P6: workflow engine writes one audit row per executed transition. Phase Z
  // fix — the literal was already in `logAction`/`logSystemAction`'s parameter
  // union (audit-logs.service.ts:103, 143) but missing here, leaving
  // `createLog(..., { action: 'workflow.transition.executed' })` as a TS2322.
  'workflow.transition.executed',
  // P8/D5: workflow draft + publish lifecycle and the P7 B4 cleanup
  // (assignment.changed). All four widen the action literal across the
  // audit pipeline so callers can write a typed action string without
  // an `as never` cast.
  'workflow.draft.created',
  'workflow.draft.discarded',
  'workflow.published',
  'workflow.assignment.changed',
  // Form Builder approval history — one audit row per approval action, under the
  // `form_approval` entity_type/category. `submitted` opens the timeline, `approved`/
  // `rejected` capture each approver's verdict (with the reason in `changes.reason`),
  // `auto_cancelled` marks a peer step voided once a layer's quorum is met, and
  // `finalized` records the envelope outcome (`changes.status`).
  'form.approval.submitted',
  'form.approval.approved',
  'form.approval.rejected',
  'form.approval.auto_cancelled',
  'form.approval.finalized',
  // Backup & Restore writes one row per target/scheme/run/restore mutation under the
  // `backup_*` and `restore_*` entity types. A single action literal is enough because the
  // entity_type already says which object moved and `changes` carries the detail.
  'backup',
] as const;

export class CreateAuditLogDto {
  @ApiProperty({
    example: 'task',
    description: 'Type of the entity being audited',
    maxLength: 100,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  entity_type!: string;

  @ApiPropertyOptional({
    description: 'UUID of the entity being audited',
  })
  @IsOptional()
  @IsUUID()
  entity_id?: string;

  @ApiProperty({
    enum: AUDIT_ACTIONS,
    example: 'create',
    description: 'Action performed on the entity',
  })
  @IsIn(AUDIT_ACTIONS)
  action!: (typeof AUDIT_ACTIONS)[number];

  @ApiPropertyOptional({
    description: 'Arbitrary JSONB diff or metadata about the change',
  })
  @IsOptional()
  @IsObject()
  changes?: Record<string, unknown>;
}
