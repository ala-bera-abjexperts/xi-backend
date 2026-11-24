/**
 * @fileoverview Body of POST /system-config/apply. This is only a shape check: the
 * updater sidecar re-validates every key and value against config-catalog.json
 * (known key, editable, type, range, pattern), and that check is the authoritative one.
 * @module src/on-prem-config/dto/apply-server-config.dto
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  registerDecorator,
} from 'class-validator';

/** Same key grammar as the sidecar and the overrides file. */
export const CONFIG_KEY = /^[A-Z][A-Z0-9_]*$/;
const MAX_KEYS = 250;
const MAX_VALUE = 4096;

/** `set` must be `{KEY: string}` with at most 250 keys, each value ≤4096 chars and
 * free of `\n`, `\r` and `\0` (a value can never break out of its line in the
 * overrides file, even before the sidecar sees it). */
function IsConfigSet(): PropertyDecorator {
  return (target, propertyKey) =>
    registerDecorator({
      name: 'isConfigSet',
      target: target.constructor,
      propertyName: propertyKey as string,
      validator: {
        validate: (value: unknown) => {
          if (!value || typeof value !== 'object' || Array.isArray(value))
            return false;
          const entries = Object.entries(value);
          return (
            entries.length <= MAX_KEYS &&
            entries.every(
              ([k, v]) =>
                CONFIG_KEY.test(k) &&
                typeof v === 'string' &&
                v.length <= MAX_VALUE &&
                !/[\n\r\0]/.test(v),
            )
          );
        },
        defaultMessage: () =>
          `set must map at most ${MAX_KEYS} keys matching ${CONFIG_KEY.source} to strings of at most ${MAX_VALUE} characters without line breaks or NUL`,
      },
    });
}

export class ApplyServerConfigDto {
  @ApiProperty({
    description: 'The `revision` from GET /system-config (stale → 409)',
  })
  @IsString()
  @MaxLength(128)
  revision!: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'Keys to override, with their new values',
  })
  @IsOptional()
  @IsObject()
  @IsConfigSet()
  set?: Record<string, string>;

  @ApiPropertyOptional({
    type: [String],
    description: 'Overridden keys to reset to the server file value',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_KEYS)
  @IsString({ each: true })
  @Matches(CONFIG_KEY, { each: true })
  reset?: string[];
}
