/**
 * @fileoverview DTO for publishing a workflow draft. Carries an optional
 *   migration map keyed by orphan status UUID → target status UUID.
 *   Per P8 D13 (risk register), every key AND value must be a valid UUID
 *   before reaching the RPC so a malformed map fails fast at the HTTP
 *   boundary instead of inside `publish_workflow_atomic`'s `::uuid` cast
 *   (which would surface as a generic 400 with a leaking sqlstate).
 * @module src/workflows/dto/publish-workflow.dto
 * @author Rajbha Manek
 */
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsObject,
  IsOptional,
  registerDecorator,
  type ValidationOptions,
} from 'class-validator';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Custom class-validator decorator: every key and every value of the
 * `Record<string,string>` must match the canonical UUID format. Empty
 * objects are allowed (publish without any mapping is the common path
 * when there are zero orphan statuses).
 */
function IsUuidKeyedRecord(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'IsUuidKeyedRecord',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          if (value === undefined || value === null) return true;
          if (typeof value !== 'object' || Array.isArray(value)) return false;
          const entries = Object.entries(value as Record<string, unknown>);

          for (const [k, v] of entries) {
            if (!UUID_REGEX.test(k)) return false;
            if (typeof v !== 'string' || !UUID_REGEX.test(v)) return false;
          }

          return true;
        },
        defaultMessage(): string {
          return 'migration_map must be an object with UUID keys mapped to UUID values';
        },
      },
    });
  };
}

export class PublishWorkflowDto {
  @ApiPropertyOptional({
    description:
      'Map of orphan status_id → target status_id (both UUID). Required only when the draft removes any status the parent currently uses.',
    type: 'object',
    additionalProperties: { type: 'string', format: 'uuid' },
  })
  @IsOptional()
  @IsObject()
  @IsUuidKeyedRecord()
  migration_map?: Record<string, string>;
}
