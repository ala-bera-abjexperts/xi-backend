import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

// Body for the HubSpot contact-property picker. The credential is optional: when editing an
// existing integration the dialog leaves it blank and the server falls back to the stored token.
export class ListHubspotPropertiesDto {
  @ApiPropertyOptional({
    description:
      'HubSpot Private App token to list contact properties with. Omit to reuse the stored credential.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  credential?: string;
}
