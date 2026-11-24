import { ApiProperty } from '@nestjs/swagger';
import {
  IsArray,
  IsNotEmpty,
  IsObject,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

import { FormPaymentSelectionDto } from '../../dto/create-form-payment-session.dto';

/**
 * Anonymous checkout body.
 *
 * Deliberately a separate class from `CreateFormPaymentSessionDto` rather than an extension of it,
 * because of the ONE property it must not inherit: `is_test`. That flag bypasses the
 * published-status, `max_responses` and `allow_multiple_submissions` gates in the submissions
 * service, and it is client-supplied — an anonymous caller that could set it would be able to
 * submit to a draft form. The global `forbidNonWhitelisted` pipe turns an attempt to send it into a
 * 400 rather than a silent bypass.
 *
 * `field_key`, `selections` and `submission_data` are safe to accept as-is: the server re-prices the
 * order from the stored catalog, so the caller cannot dictate the charge.
 */
export class PublicFormPaymentSessionDto {
  @ApiProperty({
    description: 'field_key of the `products` field being paid for.',
  })
  @IsString()
  @IsNotEmpty()
  field_key: string;

  @ApiProperty({
    description: 'Selected products and their quantities.',
    type: [FormPaymentSelectionDto],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FormPaymentSelectionDto)
  selections: FormPaymentSelectionDto[];

  @ApiProperty({
    description:
      'Full answer map keyed by field_key. Validated and saved as a draft submission before charging.',
  })
  @IsObject()
  submission_data: Record<string, unknown>;
}
