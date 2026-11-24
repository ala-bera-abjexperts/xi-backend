/**
 * @fileoverview Request DTOs for the chat API (XE-T353). The global ValidationPipe
 * runs with whitelist + forbidNonWhitelisted + transform. The organization is
 * never part of a DTO: it always comes from the RequestUser.
 * @module src/chat/dto/chat.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateBy,
  ValidateNested,
} from 'class-validator';
import { IsIanaTimezone } from '../../backup/dto/is-iana-timezone.validator';
import { isWorkingHours, type WorkingHours } from '../chat-notify-policy';

/** Object types a message can reference (user mentions come from the html). */
export const CHAT_OBJECT_REF_TYPES = [
  'task',
  'wiki_page',
  'plan',
  'board',
  'asset_object',
  'fe_node',
] as const;
export type ChatObjectRefType = (typeof CHAT_OBJECT_REF_TYPES)[number];

/** A group holds at most 500 members including the creator. */
const MAX_GROUP_INVITEES = 499;

/** Object types the search can filter by (the ones chat resolves into cards). */
export const CHAT_SEARCH_OBJECT_TYPES = ['task', 'wiki_page'] as const;

/** A query-string boolean: 'true' / 'false'. Anything else fails @IsBoolean. */
const QueryBoolean = () =>
  Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  );

export class CreateDmDto {
  @ApiProperty({
    description:
      'The other person (public.users.id); your own id opens your notes',
  })
  @IsUUID()
  userId!: string;
}

export class CreateGroupDto {
  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @ApiProperty({ type: [String], maxItems: MAX_GROUP_INVITEES })
  @IsArray()
  @ArrayMaxSize(MAX_GROUP_INVITEES)
  @IsUUID('all', { each: true })
  memberIds!: string[];
}

export class UpdateConversationDto {
  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;
}

export class UpdateMyConversationStateDto {
  @ApiPropertyOptional({ enum: ['all', 'mentions', 'none'] })
  @IsOptional()
  @IsIn(['all', 'mentions', 'none'])
  notifyLevel?: 'all' | 'mentions' | 'none';

  @ApiPropertyOptional({
    description: 'ISO timestamp; null un-mutes',
    nullable: true,
  })
  @IsOptional()
  @IsISO8601()
  mutedUntil?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  pinned?: boolean;

  @ApiPropertyOptional({
    description:
      'true = a mention no longer breaks through mute or "nothing" here',
  })
  @IsOptional()
  @IsBoolean()
  muteMentions?: boolean;
}

/** PATCH /chat/settings. null clears a value; a missing key leaves it alone. */
export class UpdateChatSettingsDto {
  @ApiPropertyOptional({
    description:
      'Do not disturb until this ISO timestamp; null switches it off',
    nullable: true,
  })
  @IsOptional()
  @IsISO8601()
  dndUntil?: string | null;

  @ApiPropertyOptional({
    description:
      "{ mon: { start: '08:00', end: '17:00' }, … }: a missing day is a day off, start > end runs overnight, start = end is rejected. Needs a timezone.",
    nullable: true,
  })
  @IsOptional()
  @ValidateBy({
    name: 'isWorkingHours',
    validator: {
      validate: isWorkingHours,
      defaultMessage: () =>
        "workingHours must map mon…sun to { start, end } in 'HH:mm' with start different from end",
    },
  })
  workingHours?: WorkingHours | null;

  @ApiPropertyOptional({ example: 'Europe/Vienna', nullable: true })
  @IsOptional()
  @IsIanaTimezone()
  @MaxLength(64)
  timezone?: string | null;

  @ApiPropertyOptional({
    enum: [0, 15, 30, 60],
    description: 'Minutes before an unread mention or DM is emailed; 0 = never',
  })
  @IsOptional()
  @IsIn([0, 15, 30, 60])
  emailFallbackMinutes?: 0 | 15 | 30 | 60;
}

export class ChatAvailabilityDto {
  @ApiProperty({ type: [String], minItems: 1, maxItems: 50 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  userIds!: string[];
}

export class AddMembersDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_GROUP_INVITEES)
  @IsUUID('all', { each: true })
  userIds!: string[];

  @ApiPropertyOptional({
    description: 'false = the new members only see messages from now on',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  fullHistory?: boolean;
}

export class SetMemberRoleDto {
  @ApiProperty({ enum: ['owner', 'member'] })
  @IsIn(['owner', 'member'])
  role!: 'owner' | 'member';
}

export class ChatObjectRefDto {
  @ApiProperty({ enum: CHAT_OBJECT_REF_TYPES })
  @IsIn(CHAT_OBJECT_REF_TYPES as unknown as string[])
  type!: ChatObjectRefType;

  @ApiProperty()
  @IsUUID()
  id!: string;
}

export class SendMessageDto {
  @ApiProperty({
    description:
      'Client-generated message id; resending the same id is idempotent',
  })
  @IsUUID()
  id!: string;

  @ApiProperty({ maxLength: 100000 })
  @IsString()
  @MaxLength(100000)
  bodyHtml!: string;

  @ApiPropertyOptional({ description: 'Reply in the thread of this message' })
  @IsOptional()
  @IsUUID()
  threadRootId?: string;

  @ApiPropertyOptional({ description: 'Quote this message' })
  @IsOptional()
  @IsUUID()
  quotedMessageId?: string;

  @ApiPropertyOptional({ type: [ChatObjectRefDto], maxItems: 50 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ChatObjectRefDto)
  objectRefs?: ChatObjectRefDto[];

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 10,
    description:
      'Files the client will upload to this message (entity_type chat_message); > 0 allows an empty body',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10)
  attachmentCount?: number;

  @ApiPropertyOptional({
    example: 'Europe/Vienna',
    description:
      "The sender's IANA timezone; stored on a Robert run only (his dates), never as working hours",
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @IsIanaTimezone()
  timezone?: string;
}

export class EditMessageDto {
  @ApiProperty({ maxLength: 100000 })
  @IsString()
  @MaxLength(100000)
  bodyHtml!: string;

  @ApiPropertyOptional({ type: [ChatObjectRefDto], maxItems: 50 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ChatObjectRefDto)
  objectRefs?: ChatObjectRefDto[];
}

export class ListMessagesQueryDto {
  @ApiPropertyOptional({
    description: 'Older page: messages with seq < beforeSeq',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  beforeSeq?: number;

  @ApiPropertyOptional({
    description: 'Catch-up: messages with seq > afterSeq, oldest first',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  afterSeq?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({
    description: 'List the replies of this thread instead of the main timeline',
  })
  @IsOptional()
  @IsUUID()
  threadRootId?: string;

  @ApiPropertyOptional({
    description:
      'The window around this message (a thread reply: around its thread root, unless threadRootId is given). Not together with beforeSeq / afterSeq.',
  })
  @IsOptional()
  @IsUUID()
  aroundMessageId?: string;
}

export class MarkReadDto {
  @ApiProperty({ description: 'Last read message seq' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  seq!: number;

  @ApiPropertyOptional({
    description: 'true = move the read position back ("mark as unread")',
  })
  @IsOptional()
  @IsBoolean()
  markUnread?: boolean;
}

/** GET /chat/search: `q` or at least one filter is required. */
export class SearchMessagesQueryDto {
  @ApiPropertyOptional({
    minLength: 1,
    maxLength: 200,
    description: 'Words or "an exact phrase"; -word excludes a word',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  q?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  conversationId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  authorId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({ description: 'true = only messages with a file' })
  @IsOptional()
  @QueryBoolean()
  @IsBoolean()
  hasAttachment?: boolean;

  @ApiPropertyOptional({
    description: 'true = only messages with an object card',
  })
  @IsOptional()
  @QueryBoolean()
  @IsBoolean()
  hasObject?: boolean;

  @ApiPropertyOptional({ enum: CHAT_SEARCH_OBJECT_TYPES })
  @IsOptional()
  @IsIn(CHAT_SEARCH_OBJECT_TYPES as unknown as string[])
  objectType?: (typeof CHAT_SEARCH_OBJECT_TYPES)[number];

  @ApiPropertyOptional({ description: 'true = only pinned messages' })
  @IsOptional()
  @QueryBoolean()
  @IsBoolean()
  pinned?: boolean;

  @ApiPropertyOptional({ description: 'true = only messages that mention me' })
  @IsOptional()
  @QueryBoolean()
  @IsBoolean()
  mentionsMe?: boolean;

  @ApiPropertyOptional({
    description: 'nextCursor of the page before (opaque)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

export class ChatRealtimeTokenDto {
  @ApiPropertyOptional({
    type: [String],
    maxItems: 50,
    description:
      'Conversations to subscribe to; ones you cannot read are dropped',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  conversationIds?: string[];
}

export class ResolveChatRefsDto {
  @ApiProperty({ type: [ChatObjectRefDto], maxItems: 100 })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ChatObjectRefDto)
  refs!: ChatObjectRefDto[];
}
