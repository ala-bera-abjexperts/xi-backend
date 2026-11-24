import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CLIENT_SUBMISSION_SURFACES } from '../submission-surface.util';
import type { ClientSubmissionSurface } from '../submission-surface.util';

export class FormPaymentSelectionDto {
  @ApiProperty({
    description: 'Catalog product id, taken from the products field options.',
  })
  @IsString()
  @IsNotEmpty()
  product_id: string;

  @ApiProperty({
    description:
      'Requested quantity. Clamped server-side to the product min/max.',
    minimum: 0,
  })
  @IsInt()
  @Min(0)
  quantity: number;
}

export class CreateFormPaymentSessionDto {
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

  @ApiPropertyOptional({
    description:
      'Marks a preview/test payment from the builder — bypasses the published-status gate.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  is_test?: boolean;

  @ApiPropertyOptional({
    description:
      'Where the form was filled; carried onto the draft so the paid submission honours its ticket switch.',
    enum: CLIENT_SUBMISSION_SURFACES,
  })
  @IsOptional()
  @IsIn(CLIENT_SUBMISSION_SURFACES)
  surface?: ClientSubmissionSurface;
}
