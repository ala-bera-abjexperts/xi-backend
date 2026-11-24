import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Matches,
} from 'class-validator';

export class CreateCheckoutSessionDto {
  @ApiProperty({ description: 'Published Site Studio funnel id' })
  @IsUUID()
  funnel_id!: string;

  @ApiProperty({
    description: 'Stripe price ids configured on the funnel',
    type: [String],
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  @Matches(/^price_/, {
    each: true,
    message: 'One or more price IDs are misconfigured. Contact support.',
  })
  price_ids!: string[];

  @ApiProperty({
    description:
      'Absolute published page URL that Stripe redirects back to after checkout',
    required: false,
  })
  @IsOptional()
  @IsUrl({ require_tld: false, require_protocol: true })
  return_url?: string;
}
