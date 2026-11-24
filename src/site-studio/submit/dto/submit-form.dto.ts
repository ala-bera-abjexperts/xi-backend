import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class SubmitFormDto {
  @ApiProperty({ description: 'UUID of the funnel' })
  @IsUUID()
  funnel_id!: string;

  @ApiPropertyOptional({ description: 'UUID of the source page' })
  @IsOptional()
  @Transform(({ value }) => (value === '' ? undefined : (value as string)))
  @IsUUID()
  page_id?: string;

  @ApiPropertyOptional({
    description: 'ID of the contactForm element in the page tree',
  })
  @IsOptional()
  @Transform(({ value }) => (value === '' ? undefined : (value as string)))
  @IsString()
  @MaxLength(255)
  form_element_id?: string;

  @ApiProperty({
    description: 'Key/value map of field_name → value (max 50 keys)',
  })
  @IsObject()
  form_data!: Record<string, unknown>;
}
