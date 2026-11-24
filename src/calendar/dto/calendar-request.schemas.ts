/**
 * @fileoverview Zod schemas for the calendar path parameters.
 *
 * Only path parameters live here, and that is deliberate. NestJS's global `ValidationPipe` validates
 * any parameter whose metatype is a class, so a `@Body()` typed as a DTO is checked by
 * class-validator **before** a Zod pipe on the same parameter can run. Schemas for request bodies
 * therefore could never fire, and were removed rather than left as decoration — the DTOs in this
 * folder remain the single authority on what a body may contain.
 *
 * A path parameter's metatype is `String`, which `toValidate()` skips
 * (`@nestjs/common/pipes/validation.pipe.js`), so here the Zod pipe really is the only check.
 * Nothing validated these before: a malformed `:id` went straight through to the service.
 * @module src/calendar/dto/calendar-request.schemas
 */

import { z } from 'zod';

/** Every `:id` on a calendar route is a row id; the services all look one up by uuid. */
export const calendarIdParamSchema = z.uuid();

/**
 * The four `CalendarProvidersService` knows.
 *
 * Mirrors its own switch, which already throws `Unknown calendar provider` for anything else — so
 * this refuses exactly what the service refuses, only a little earlier.
 */
export const calendarProviderParamSchema = z.enum([
  'google',
  'microsoft',
  'calendly',
  'ics',
  'zoom',
]);
