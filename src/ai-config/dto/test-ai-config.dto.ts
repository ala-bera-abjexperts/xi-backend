import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

import { AI_MODEL_PATTERN, AiProvider } from './save-ai-config.dto';

/** Values still in the form; whatever is left out is taken from the saved configuration. */
export class TestAiConfigDto {
  @ApiPropertyOptional({
    description:
      'Legacy compatibility field, as on save. Ignored; organization is derived from auth context.',
  })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiPropertyOptional({ enum: AiProvider })
  @IsOptional()
  @IsEnum(AiProvider)
  provider_name?: AiProvider;

  @ApiPropertyOptional({
    description:
      'An API key that is not saved yet. Required when the provider differs from the saved one.',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  api_key?: string;

  @ApiPropertyOptional({
    description: 'Model (for Azure: deployment name) to test.',
    maxLength: 128,
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  @Matches(AI_MODEL_PATTERN)
  model?: string;
}
