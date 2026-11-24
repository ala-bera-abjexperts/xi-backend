/**
 * @fileoverview Request DTOs of the Robert API (XE-T353, contract section 4.1). The
 * global ValidationPipe runs with whitelist + forbidNonWhitelisted + transform. The
 * organization is never part of a DTO: it always comes from the RequestUser.
 * @module src/chat-agent/dto/agent.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateBy,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { MAX_ACTIONS_PER_RUN, RUN_RESERVE_TOKENS } from '../agent.constants';

/** PUT /chat/agent/settings: the whole settings object, every time. */
export class UpdateAgentSettingsDto {
  @ApiProperty({ description: 'false switches Robert off for the tenant' })
  @IsBoolean()
  enabled!: boolean;

  @ApiProperty({ description: 'May Robert be mentioned in direct messages' })
  @IsBoolean()
  allowInDms!: boolean;

  // A cap below one run's reservation could never start a run. null removes the
  // cap; a missing value fails like any other number.
  @ApiProperty({
    nullable: true,
    minimum: RUN_RESERVE_TOKENS,
    description: 'Tokens per UTC month for the whole tenant; null = no cap',
  })
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(RUN_RESERVE_TOKENS)
  @Max(Number.MAX_SAFE_INTEGER)
  monthlyTokenCap!: number | null;

  @ApiProperty({
    nullable: true,
    minimum: RUN_RESERVE_TOKENS,
    description: 'Tokens per UTC day for one person; null = no cap',
  })
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(RUN_RESERVE_TOKENS)
  @Max(Number.MAX_SAFE_INTEGER)
  userDailyTokenCap!: number | null;

  @ApiProperty({
    description: 'true also keeps the full prompt of a run, not only its hash',
  })
  @IsBoolean()
  storePrompts!: boolean;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** GET /chat/agent/usage: a period of whole UTC days, both ends included. */
export class AgentUsageQueryDto {
  @ApiProperty({ example: '2026-10-01' })
  @Matches(DAY)
  @IsISO8601({ strict: true })
  from!: string;

  @ApiProperty({ example: '2026-10-31' })
  @Matches(DAY)
  @IsISO8601({ strict: true })
  to!: string;
}

/** At most this many ids in one resolve, run and request ids together. */
export const MAX_RESOLVE_IDS = 100;

/** POST /chat/agent/runs/resolve */
export class ResolveAgentRunsDto {
  @ApiPropertyOptional({ type: [String], maxItems: MAX_RESOLVE_IDS })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_RESOLVE_IDS)
  @IsUUID('all', { each: true })
  runIds?: string[];

  @ApiPropertyOptional({
    type: [String],
    maxItems: MAX_RESOLVE_IDS,
    description: 'Every run of these requests',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_RESOLVE_IDS)
  @IsUUID('all', { each: true })
  @ValidateBy({
    name: 'resolveIdsTogether',
    validator: {
      validate: (_: unknown, args) => {
        const dto = args?.object as ResolveAgentRunsDto;
        return (
          (dto.runIds?.length ?? 0) + (dto.triggerMessageIds?.length ?? 0) <=
          MAX_RESOLVE_IDS
        );
      },
      defaultMessage: () =>
        `runIds and triggerMessageIds hold at most ${MAX_RESOLVE_IDS} ids together`,
    },
  })
  triggerMessageIds?: string[];
}

// ---------------------------------------------------------------------------
// Proposals (1.14)
// ---------------------------------------------------------------------------

/** One edit of one proposal: the fields it sets, checked by the executor key by key. */
export class AgentActionChangeDto {
  @ApiProperty()
  @IsUUID()
  actionId!: string;

  @ApiProperty({ description: 'The version the invoker saw' })
  @IsInt()
  @Min(1)
  version!: number;

  @ApiProperty({
    description:
      'title, description, space, type, status, priority, assignee, due, labels, parent or custom:<fieldId>',
    example: { priority: 'b3c1…' },
  })
  @IsObject()
  fields!: Record<string, unknown>;
}

/** PATCH /chat/agent/runs/:id/actions */
export class PatchAgentActionsDto {
  @ApiProperty({ type: [AgentActionChangeDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_ACTIONS_PER_RUN)
  @ValidateNested({ each: true })
  @Type(() => AgentActionChangeDto)
  changes!: AgentActionChangeDto[];
}

export class AgentActionVersionDto {
  @ApiProperty()
  @IsUUID()
  id!: string;

  @ApiProperty()
  @IsInt()
  @Min(1)
  version!: number;
}

/** POST /chat/agent/runs/:id/undo. Without actions: the whole batch. */
export class UndoAgentActionsDto {
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_ACTIONS_PER_RUN)
  @IsUUID('4', { each: true })
  actions?: string[];
}

/** POST /chat/agent/runs/:id/confirm */
export class ConfirmAgentActionsDto {
  @ApiProperty({ type: [AgentActionVersionDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_ACTIONS_PER_RUN)
  @ValidateNested({ each: true })
  @Type(() => AgentActionVersionDto)
  actions!: AgentActionVersionDto[];
}

/** POST /chat/agent/actions/:id/retry */
export class RetryAgentActionDto {
  @ApiProperty()
  @IsInt()
  @Min(1)
  version!: number;
}

/** POST /chat/agent/runs/:id/feedback */
export class AgentFeedbackDto {
  @ApiProperty({ enum: ['up', 'down'] })
  @IsIn(['up', 'down'])
  rating!: 'up' | 'down';
}

/** At most this many audit rows per page. */
export const MAX_AUDIT_PAGE = 100;

/** GET /chat/agent/audit */
export class AgentAuditQueryDto {
  @ApiPropertyOptional({ description: 'ISO date or timestamp, inclusive' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({
    description: 'ISO date (the whole day) or timestamp, inclusive',
  })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  actorId?: string;

  @ApiPropertyOptional({ example: 'action.confirmed' })
  @IsOptional()
  @Matches(/^[a-z][a-z_.]{0,63}$/)
  event?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  conversationId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  runId?: string;

  @ApiPropertyOptional({ description: 'nextCursor of the previous page' })
  @IsOptional()
  @Matches(/^\d{1,19}$/)
  cursor?: string;

  @ApiPropertyOptional({ maximum: MAX_AUDIT_PAGE, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_AUDIT_PAGE)
  limit?: number;
}

/** GET /chat/agent/audit/export */
export class AgentAuditExportDto extends AgentAuditQueryDto {
  @ApiProperty({ enum: ['csv', 'json'] })
  @IsIn(['csv', 'json'])
  format!: 'csv' | 'json';
}
