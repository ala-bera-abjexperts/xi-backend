import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import {
  CALENDAR_MAX_SHARES,
  CALENDAR_SHARE_LEVELS,
  CALENDAR_SHARE_TARGET_TYPES,
} from './calendar-validation';

/** Read, change and remove, for one kind of content. */
class CalendarShareActionsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  read?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  update?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  delete?: boolean;
}

/** Entries on the calendar, split by who wrote them. */
class CalendarShareEventsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  create?: boolean;

  @ApiPropertyOptional({ type: CalendarShareActionsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CalendarShareActionsDto)
  own?: CalendarShareActionsDto;

  @ApiPropertyOptional({ type: CalendarShareActionsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CalendarShareActionsDto)
  others?: CalendarShareActionsDto;
}

/** Copies pulled in from a connected calendar, and the connection itself. */
class CalendarShareSyncDto extends CalendarShareActionsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  create?: boolean;

  @ApiPropertyOptional({ description: 'Link, run and unlink the connection' })
  @IsOptional()
  @IsBoolean()
  manage?: boolean;
}

/** The calendar object itself, apart from managing it. */
class CalendarShareCalendarDto {
  @ApiPropertyOptional({
    description: 'Name, colour, description and visibility',
  })
  @IsOptional()
  @IsBoolean()
  edit?: boolean;

  @ApiPropertyOptional({ description: 'Remove the calendar' })
  @IsOptional()
  @IsBoolean()
  delete?: boolean;

  @ApiPropertyOptional({
    description: 'Create calendars; absent means allowed, false withholds it',
  })
  @IsOptional()
  @IsBoolean()
  create?: boolean;
}

/** The module's four tabs. Absent means shown, so an older share keeps every tab. */
class CalendarShareTabsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  calendar?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  integrations?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  sharing?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  settings?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  tickets?: boolean;
}

/** The Link ticket tab's boxes. Absent flags are not granted. */
class CalendarShareTicketsDto {
  @ApiPropertyOptional({ description: 'See the form that links a ticket' })
  @IsOptional()
  @IsBoolean()
  form?: boolean;

  @ApiPropertyOptional({ description: 'Link tickets to a calendar' })
  @IsOptional()
  @IsBoolean()
  link?: boolean;

  @ApiPropertyOptional({ description: 'See the list of linked tickets' })
  @IsOptional()
  @IsBoolean()
  list?: boolean;

  @ApiPropertyOptional({ description: 'Remove a linked ticket' })
  @IsOptional()
  @IsBoolean()
  delete?: boolean;

  @ApiPropertyOptional({ description: 'Remove several linked tickets at once' })
  @IsOptional()
  @IsBoolean()
  delete_many?: boolean;
}

/** Ticket dates on this calendar, plus showing it in the Linked tickets list. */
class CalendarShareTaskEventsDto extends CalendarShareActionsDto {
  @ApiPropertyOptional({
    description: 'Offer this calendar in the Link form',
  })
  @IsOptional()
  @IsBoolean()
  form?: boolean;

  @ApiPropertyOptional({
    description: 'Show this calendar in the Linked tickets list',
  })
  @IsOptional()
  @IsBoolean()
  list?: boolean;
}

/** This calendar's connection to an outside one. Absent flags are not granted. */
class CalendarShareIntegrationsDto {
  @ApiPropertyOptional({ description: 'See the connection and what it offers' })
  @IsOptional()
  @IsBoolean()
  view?: boolean;

  @ApiPropertyOptional({ description: 'Link this calendar to an outside one' })
  @IsOptional()
  @IsBoolean()
  create?: boolean;

  @ApiPropertyOptional({ description: 'Run a sync now' })
  @IsOptional()
  @IsBoolean()
  update?: boolean;

  @ApiPropertyOptional({ description: 'Unlink it' })
  @IsOptional()
  @IsBoolean()
  delete?: boolean;

  @ApiPropertyOptional({
    description: "Open the provider's accounts: add, reconnect or remove them",
  })
  @IsOptional()
  @IsBoolean()
  manage?: boolean;

  @ApiPropertyOptional({
    description: 'See the list of entries brought in from outside calendars',
  })
  @IsOptional()
  @IsBoolean()
  records?: boolean;

  @ApiPropertyOptional({
    description: 'See the sync section on the Integrations tab',
  })
  @IsOptional()
  @IsBoolean()
  sync_section?: boolean;

  @ApiPropertyOptional({ description: 'See the list of active integrations' })
  @IsOptional()
  @IsBoolean()
  active_list?: boolean;

  @ApiPropertyOptional({ description: 'Stop this calendar syncing' })
  @IsOptional()
  @IsBoolean()
  stop_sync?: boolean;
}

/** Reading the access list itself. */
class CalendarShareSharingDto {
  @ApiPropertyOptional({
    description: 'See who else this calendar is shared with',
  })
  @IsOptional()
  @IsBoolean()
  view?: boolean;

  @ApiPropertyOptional({ description: 'Add people to this calendar' })
  @IsOptional()
  @IsBoolean()
  add?: boolean;

  @ApiPropertyOptional({
    description: 'Change or remove the access other people already have',
  })
  @IsOptional()
  @IsBoolean()
  manage?: boolean;
}

/** What one share allows, per kind of content. Absent flags are not granted. */
export class CalendarSharePermissionsDto {
  @ApiPropertyOptional({ type: CalendarShareEventsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CalendarShareEventsDto)
  events?: CalendarShareEventsDto;

  @ApiPropertyOptional({ type: CalendarShareTaskEventsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CalendarShareTaskEventsDto)
  task_events?: CalendarShareTaskEventsDto;

  @ApiPropertyOptional({ type: CalendarShareSyncDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CalendarShareSyncDto)
  sync?: CalendarShareSyncDto;

  @ApiPropertyOptional({ type: CalendarShareCalendarDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CalendarShareCalendarDto)
  calendar?: CalendarShareCalendarDto;

  @ApiPropertyOptional({ type: CalendarShareTabsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CalendarShareTabsDto)
  tabs?: CalendarShareTabsDto;

  @ApiPropertyOptional({ type: CalendarShareIntegrationsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CalendarShareIntegrationsDto)
  integrations?: CalendarShareIntegrationsDto;

  @ApiPropertyOptional({ type: CalendarShareTicketsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CalendarShareTicketsDto)
  tickets?: CalendarShareTicketsDto;

  @ApiPropertyOptional({ type: CalendarShareSharingDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CalendarShareSharingDto)
  sharing?: CalendarShareSharingDto;

  @ApiPropertyOptional({ description: 'Settings, sharing and deleting' })
  @IsOptional()
  @IsBoolean()
  manage?: boolean;
}

export class CalendarShareDto {
  @ApiProperty({ enum: CALENDAR_SHARE_TARGET_TYPES })
  @IsIn(CALENDAR_SHARE_TARGET_TYPES as unknown as string[])
  target_type!: string;

  @ApiProperty({ description: 'User id, or role id when target_type is role' })
  @IsUUID()
  target_id!: string;

  @ApiPropertyOptional({
    enum: CALENDAR_SHARE_LEVELS,
    description:
      'The older single level. Read when no permissions object is sent.',
  })
  @IsOptional()
  @IsIn(CALENDAR_SHARE_LEVELS as unknown as string[])
  level?: string;

  @ApiPropertyOptional({ type: CalendarSharePermissionsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CalendarSharePermissionsDto)
  permissions?: CalendarSharePermissionsDto;

  @ApiPropertyOptional({
    description: 'Space or organization role the target came from, for display',
    maxLength: 50,
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  base_role?: string;

  // Stamped by the server; accepted only because the browser echoes them back, never trusted
  @ApiPropertyOptional({
    description: 'Who last granted or changed this rule (set by the server)',
  })
  @IsOptional()
  @IsUUID()
  granted_by?: string;

  @ApiPropertyOptional({
    description:
      'When this rule was last granted or changed (set by the server)',
  })
  @IsOptional()
  @IsISO8601()
  granted_at?: string;
}

/** Replaces the whole share list of one calendar; an empty array clears it. */
export class SetCalendarSharesDto {
  @ApiProperty({ type: [CalendarShareDto], maxItems: CALENDAR_MAX_SHARES })
  @IsArray()
  @ArrayMaxSize(CALENDAR_MAX_SHARES)
  @ValidateNested({ each: true })
  @Type(() => CalendarShareDto)
  shares!: CalendarShareDto[];
}
