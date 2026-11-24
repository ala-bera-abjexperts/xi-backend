/**
 * @fileoverview The only fields the Zoom routes may send back; anything else is dropped.
 */
import { z } from 'zod';

export const calendarZoomStatusSchema = z.object({
  configured: z.boolean(),
  connected: z.boolean(),
  email: z.string().nullable().optional(),
  needsReconnect: z.boolean().optional(),
});

export type CalendarZoomStatus = z.infer<typeof calendarZoomStatusSchema>;

export const zoomMeetingDefaultsSchema = z.object({
  available: z.boolean(),
  reason: z.string().optional(),
  passcodeRequired: z.boolean().optional(),
  suggestedPasscode: z.string().nullable().optional(),
  pmi: z.string().nullable().optional(),
  pmiPasscode: z.string().nullable().optional(),
});

export type ZoomMeetingDefaults = z.infer<typeof zoomMeetingDefaultsSchema>;

const zoomRecurrenceSchema = z.strictObject({
  type: z.enum(['daily', 'weekly', 'monthly']),
  repeat_interval: z.number().int(),
  weekly_days: z.array(z.number().int()).optional(),
  monthly_day: z.number().int().optional(),
  end_times: z.number().int().optional(),
  end_date: z.string().optional(),
});

export const zoomMeetingSettingsSchema = z.strictObject({
  options: z.strictObject({
    use_pmi: z.boolean(),
    passcode_enabled: z.boolean(),
    passcode: z.string().optional(),
    waiting_room: z.boolean(),
    encryption_type: z.enum(['enhanced_encryption', 'e2ee']),
    host_video: z.boolean(),
    participant_video: z.boolean(),
    continuous_chat: z.boolean(),
    join_before_host: z.boolean(),
    mute_upon_entry: z.boolean(),
    auto_recording: z.enum(['none', 'local', 'cloud']),
    recurrence: zoomRecurrenceSchema.optional(),
  }),
  pmi: z.boolean(),
});

export type ZoomMeetingSettingsResponse = z.infer<
  typeof zoomMeetingSettingsSchema
>;
