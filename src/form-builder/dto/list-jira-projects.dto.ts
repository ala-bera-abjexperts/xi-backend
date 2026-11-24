import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

// Body for the Jira project picker. siteUrl + email identify the Atlassian account; the credential
// is optional so editing an existing integration can reuse the stored API token.
export class ListJiraProjectsDto {
  @ApiProperty({
    description: 'Atlassian site, e.g. https://your-site.atlassian.net',
  })
  @IsString()
  @MaxLength(500)
  siteUrl!: string;

  @ApiProperty({
    description: 'Atlassian account email the API token belongs to.',
  })
  @IsString()
  @MaxLength(320)
  email!: string;

  @ApiPropertyOptional({
    description: 'Atlassian API token. Omit to reuse the stored credential.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  credential?: string;
}
