import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsObject, IsOptional, IsUUID } from 'class-validator';

/**
 * Body of `POST /public/site-studio/form-submit`.
 *
 * SECURITY: the client may only name *which* form on *which* funnel/page it is
 * submitting. `organization_id` / `space_id` are never accepted from the client —
 * they are derived server-side from the `form_builder` row.
 */
export class PublicFormSubmitDto {
  @ApiProperty({ description: 'UUID of the funnel the page belongs to' })
  @IsUUID()
  funnel_id!: string;

  @ApiPropertyOptional({
    description: 'UUID of the page carrying the formBuilderForm element',
  })
  @IsOptional()
  @Transform(({ value }) => (value === '' ? undefined : (value as string)))
  @IsUUID()
  page_id?: string;

  @ApiProperty({ description: 'UUID of the form_builder form' })
  @IsUUID()
  form_id!: string;

  @ApiProperty({
    description: 'Answers keyed by field_key',
  })
  @IsObject()
  data!: Record<string, unknown>;
}
