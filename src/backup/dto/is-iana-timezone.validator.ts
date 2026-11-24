/**
 * @fileoverview Validates an IANA time-zone name on a DTO field.
 * @module src/backup/dto/is-iana-timezone.validator
 *
 * Deliberately NOT `@IsIn(Intl.supportedValuesOf('timeZone'))`: that list is canonical-only and
 * omits `'UTC'` (it carries `Etc/UTC` instead), so it would reject the column default and every
 * scheme already using it. `Intl.DateTimeFormat` accepts both, which is the behaviour we want.
 */

import type { ValidationOptions } from 'class-validator';
import { registerDecorator } from 'class-validator';
import { isValidTimezone } from '../services/backup-schedule.service';

/**
 * Rejects anything `cron-parser` would accept at parse time and then throw on.
 *
 * A wrong zone is otherwise invisible until the scheduler advances the iterator — which happens at
 * the scheduled hour, on a server, with nobody watching.
 */
export function IsIanaTimezone(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isIanaTimezone',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown): boolean {
          return typeof value === 'string' && isValidTimezone(value);
        },
        defaultMessage(): string {
          return (
            '$property must be an IANA time zone such as ' +
            "'Europe/Berlin' or 'UTC' (offsets like 'GMT+2' are not accepted)"
          );
        },
      },
    });
  };
}
