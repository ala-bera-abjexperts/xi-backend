/**
 * @fileoverview Body for a customer filling a staff-requested form (contract §8). Answers
 * are validated and cleaned against the form's own fields by Form Builder on submit.
 * @module src/help-center/dto/submit-form-request.dto
 * @author Prince Jadiya
 */

import { ApiProperty } from '@nestjs/swagger';
import { IsObject } from 'class-validator';

export class SubmitFormRequestDto {
  @ApiProperty({ type: 'object', additionalProperties: true })
  @IsObject()
  data!: Record<string, unknown>;
}
