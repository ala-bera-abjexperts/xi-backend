/**
 * @fileoverview Custom NestJS pipe that validates input data against a Zod schema.
 * Provides an alternative to class-validator for routes that use Zod schemas directly.
 * Returns structured validation error messages on failure.
 * @module src/common/pipes/zod-validation.pipe
 * @author Prince Jadiya
 */

import { PipeTransform, BadRequestException } from '@nestjs/common';
import { ZodSchema } from 'zod';

/**
 * Pipe that validates incoming data against a provided Zod schema.
 *
 * On validation failure, throws a `BadRequestException` with an array of field-level errors.
 * On success, returns the parsed (and potentially transformed) data.
 *
 * @example
 * // Use in a controller method parameter:
 * @Post()
 * create(@Body(new ZodValidationPipe(createSchema)) body: CreateDto) { ... }
 */
export class ZodValidationPipe implements PipeTransform {
  /**
   * @param {ZodSchema} schema - The Zod schema to validate against
   */
  constructor(private schema: ZodSchema) {}

  /**
   * Validates the incoming value against the Zod schema.
   *
   * @param {unknown} value - The raw input value to validate
   * @returns {unknown} The parsed and validated data
   * @throws {BadRequestException} When validation fails, with `{ message: 'Validation failed', errors: [...] }`
   */
  transform(value: unknown) {
    const result = this.schema.safeParse(value);

    if (!result.success) {
      const errors = result.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      }));

      throw new BadRequestException({ message: 'Validation failed', errors });
    }

    return result.data;
  }
}
