import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

// A product defined in the builder, pushed to the connected Stripe account.
export class CreateStripeProductDto {
  @ApiProperty()
  @IsString()
  @MaxLength(250)
  name!: string;

  @ApiProperty({ description: 'Price in major units (e.g. dollars).' })
  @IsNumber()
  @Min(0)
  price!: number;

  @ApiProperty({ description: 'ISO currency code, e.g. USD.' })
  @IsString()
  @MaxLength(10)
  currency!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  image?: string;
}
