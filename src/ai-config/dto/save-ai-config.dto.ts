import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export enum AiProvider {
  ANTHROPIC = 'anthropic',
  OPENAI = 'openai',
  GOOGLE = 'google',
  AZURE_OPENAI = 'azure_openai',
  MISTRAL = 'mistral',
}

// A model id or Azure deployment name: no blanks, quotes or brackets, which would end up in URLs,
// logs and error texts.
export const AI_MODEL_PATTERN = /^[\w.:/-]+$/;

export const AI_PROVIDER_LABELS: Record<AiProvider, string> = {
  [AiProvider.ANTHROPIC]: 'Anthropic (Claude)',
  [AiProvider.OPENAI]: 'OpenAI (ChatGPT)',
  [AiProvider.GOOGLE]: 'Google (Gemini)',
  [AiProvider.AZURE_OPENAI]: 'Azure OpenAI',
  [AiProvider.MISTRAL]: 'Mistral AI',
};

export class SaveAiConfigDto {
  @ApiPropertyOptional({
    description:
      'Legacy compatibility field. Ignored; organization is derived from auth context.',
  })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiProperty({ enum: AiProvider })
  @IsEnum(AiProvider)
  provider_name!: AiProvider;

  @ApiPropertyOptional({
    description:
      'Provider API key (max 500 chars). Leave it out to change only the model of the saved provider; it is required to set up or change the provider.',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  api_key?: string;

  @ApiPropertyOptional({
    description:
      'Model (for Azure: deployment name) Robert uses. Left out keeps the saved one; null goes back to the provider default.',
    maxLength: 128,
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  @Matches(AI_MODEL_PATTERN)
  model?: string | null;
}
