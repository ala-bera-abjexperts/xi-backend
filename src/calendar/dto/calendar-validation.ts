/**
 * @fileoverview Shared value lists and patterns for the calendar DTOs, so the API and the database
 * CHECK constraints in `20260924120000_calendar_module.sql` stay in step.
 */

export const CALENDAR_VISIBILITIES = [
  'private',
  'space',
  'organization',
] as const;

export const CALENDAR_SHARE_TARGET_TYPES = [
  'user',
  'base_role',
  'space',
] as const;

export const CALENDAR_SHARE_LEVELS = ['view', 'edit', 'manage'] as const;

export const CALENDAR_EVENT_LINK_TYPES = [
  'task',
  'process',
  'user',
  'asset_object',
] as const;

export const CALENDAR_MEETING_PROVIDERS = [
  'teams',
  'google_meet',
  'zoom',
  'custom',
] as const;

/** Which date on a ticket decides where it lands on a calendar. */
export const CALENDAR_TICKET_DATE_FIELDS = [
  'due_date',
  'start_date',
  'end_date',
] as const;

/** A date with no time part, e.g. 2026-09-24. Combined with @IsDateString so 2026-13-45 is rejected. */
export const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * An instant that names its own offset ("Z" or "+02:00").
 *
 * Without this a value like "2026-09-24T10:00" would be read in whatever zone the server runs in, and
 * the event would land at the wrong moment for everyone.
 */
export const CALENDAR_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})$/;

/** Caps on the list columns, so one request cannot store an unbounded array. */
export const CALENDAR_MAX_SHARES = 200;

export const CALENDAR_MAX_FIELDS = 100;

export const CALENDAR_MAX_WATCHERS = 200;

export const CALENDAR_MAX_LINKS = 100;

export const CALENDAR_MAX_IDS_PER_QUERY = 100;

export const CALENDAR_MAX_FEEDS = 20;
