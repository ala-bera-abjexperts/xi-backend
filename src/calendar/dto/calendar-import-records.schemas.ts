/**
 * @fileoverview Zod shape for the imported-records page.
 *
 * A warn-only drift check like calendar-response.schemas: loose, never used to reshape the payload.
 * @module src/calendar/dto/calendar-import-records.schemas
 */

import { z } from 'zod';

export const importRecordPageSchema = z.looseObject({
  items: z.array(
    z.looseObject({
      id: z.string(),
      calendar_id: z.string(),
      source: z.string(),
      status: z.enum(['synced', 'removed', 'unlinked', 'reconnect', 'error']),
    }),
  ),
  total: z.number(),
  page: z.number(),
  limit: z.number(),
});
