/**
 * @fileoverview Zod shapes for what the calendar routes hand back.
 *
 * These are a drift check, not a gate. The backend builds these payloads itself, so unlike a client
 * validating a server it cannot really be surprised — what this catches is a service quietly
 * changing the shape a screen depends on. Every schema is loose and every field that is not part of
 * the identity of the row is optional, so a new column never trips it.
 * @module src/calendar/dto/calendar-response.schemas
 */

import { z } from 'zod';

const calendarResponse = z.looseObject({
  id: z.string(),
  organization_id: z.string(),
  name: z.string(),
});

const eventResponse = z.looseObject({
  id: z.string(),
  calendar_id: z.string(),
  summary: z.string(),
});

const accountResponse = z.looseObject({
  id: z.string(),
  provider: z.string(),
});

const externalCalendarResponse = z.looseObject({
  id: z.string(),
  name: z.string(),
});

const ownerlessResponse = z.looseObject({
  id: z.string(),
  name: z.string(),
  owner_id: z.string().nullable(),
});

const ackResponse = z.looseObject({ success: z.literal(true) });

const connectUrlResponse = z.looseObject({ url: z.string() });

const icsConnectedResponse = z.looseObject({ connected: z.literal(true) });

const syncRunResponse = z.looseObject({
  imported: z.number(),
  removed: z.number(),
  reset: z.boolean(),
});

// A page of ticket ids: not yet linked (items), or linked (data)
const linkableTicketsResponse = z.looseObject({
  items: z.array(z.looseObject({ task_id: z.string() })),
  total: z.number(),
});

const ticketLinksResponse = z.looseObject({
  data: z.array(z.looseObject({ task_id: z.string() })),
  total: z.number(),
});

/** Anything a calendar route is allowed to return, as a single value. */
export const calendarResponseSchema = z.union([
  calendarResponse,
  eventResponse,
  accountResponse,
  externalCalendarResponse,
  ownerlessResponse,
  ackResponse,
  connectUrlResponse,
  icsConnectedResponse,
  syncRunResponse,
  linkableTicketsResponse,
  ticketLinksResponse,
]);
