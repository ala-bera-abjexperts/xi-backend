import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

// Providers this backend slice accepts. Must stay in sync with the DB provider CHECK on
// form_builder_integrations — a value allowed here but missing there fails at insert with 23514.
export const INTEGRATION_PROVIDERS = [
  'gmail',
  'github',
  'airtable',
  'clickup',
  'trello',
  'jira',
  'hubspot',
  'salesforce',
] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

// One field-mapping row: a target email part (toEmail/subject/body) fed by a form field
// (`source`) or a `{{field_key}}` template string.
export class FieldMapEntry {
  @ApiProperty()
  @IsString()
  target!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  source?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  template?: string;
}

export class CreateIntegrationDto {
  @ApiProperty({ enum: INTEGRATION_PROVIDERS })
  @IsIn(INTEGRATION_PROVIDERS)
  provider!: IntegrationProvider;

  @ApiProperty({
    description: 'Provider config (Gmail: { fromEmail, fromName? })',
  })
  @IsObject()
  config!: Record<string, unknown>;

  @ApiPropertyOptional({ type: [FieldMapEntry] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FieldMapEntry)
  fieldMap?: FieldMapEntry[];

  @ApiPropertyOptional({
    description: 'Write-only; encrypted at rest and never returned.',
  })
  @IsOptional()
  @IsString()
  credential?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
