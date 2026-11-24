import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

// Body for the cascading Jira issue-type picker. projectKey scopes the lookup to one project;
// the credential is optional so editing an existing integration can reuse the stored API token.
export class ListJiraIssueTypesDto {
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

  @ApiProperty({
    description: 'Project key to list creatable issue types for, e.g. ENG.',
  })
  @IsString()
  @MaxLength(100)
  projectKey!: string;

  @ApiPropertyOptional({
    description: 'Atlassian API token. Omit to reuse the stored credential.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  credential?: string;
}
