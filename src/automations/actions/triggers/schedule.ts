import type { CatalogTrigger } from '../../automation-trigger-catalog.service';

export const scheduleCronTrigger: CatalogTrigger = {
  kind: 'schedule.cron',
  category: 'schedule',
  type: 'trigger',
  label: { en: 'Schedule', de: 'Zeitplan' },
  description: {
    en: 'Run on a recurring schedule using a cron expression',
    de: 'Wird nach einem wiederkehrenden Zeitplan mit einem Cron-Ausdruck ausgeführt',
  },
  icon: 'bx-time',
  configSchema: {
    type: 'object',
    properties: {
      cron: {
        type: 'string',
        title: 'Cron expression',
        description:
          'Standard 5-field cron expression — e.g. "0 9 * * 1" for every Monday at 09:00',
      },
      timezone: {
        type: 'string',
        title: 'Timezone',
        default: 'UTC',
        description:
          'Timezone for the schedule — e.g. "Europe/Berlin", "America/New_York". Defaults to UTC',
      },
      startDate: {
        type: 'string',
        title: 'Start date',
        description:
          'Only start firing on or after this date (YYYY-MM-DD). Leave blank for no start bound.',
      },
      endDate: {
        type: 'string',
        title: 'End date',
        description:
          'Stop firing after this date (YYYY-MM-DD, inclusive). Leave blank for no end bound.',
      },
    },
    required: ['cron'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      fired_at: { type: 'string', title: 'Fired at (ISO datetime)' },
    },
  },
};

export const scheduleTriggers: CatalogTrigger[] = [scheduleCronTrigger];
