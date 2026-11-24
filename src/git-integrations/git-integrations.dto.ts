/**
 * @fileoverview Request bodies for the Git integrations admin API.
 * @module src/git-integrations/git-integrations.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class UpdateGitRepositoriesDto {
  @ApiProperty({ enum: ['all', 'selected'] })
  @IsIn(['all', 'selected'])
  selection!: 'all' | 'selected';

  @ApiProperty({
    type: [String],
    description: 'Repository row ids to enable when selection is "selected"',
  })
  @ArrayMaxSize(5000)
  @IsUUID('4', { each: true })
  enabledIds!: string[];
}

export class UpdateSpaceGitRepositoriesDto {
  @ApiProperty({
    type: [String],
    description: 'Repository row ids assigned to the space (the full list)',
  })
  @ArrayMaxSize(5000)
  @IsUUID('4', { each: true })
  repositoryIds!: string[];

  @ApiProperty({
    type: [String],
    description:
      'The assigned ids the client loaded; the save is refused (409) when they changed meanwhile',
  })
  @ArrayMaxSize(5000)
  @IsUUID('4', { each: true })
  expectedRepositoryIds!: string[];
}

export class UpdateGitSettingsDto {
  @ApiProperty()
  @IsBoolean()
  linkCommits!: boolean;

  @ApiProperty()
  @IsBoolean()
  showBuildStatus!: boolean;
}

/** Same rules as the git_branch_settings CHECK constraint (ticket 3). */
// Git ref rules that a prefix can break: no '..', no '//', no part starting or ending with '.',
// no part ending in '.lock', not starting with '/', '.' or '-'.
export const BRANCH_PREFIX_PATTERN =
  /^(?![/.-])(?!.*\.\.)(?!.*\/\/)(?!.*\/\.)(?!.*\.\/)(?!.*\.lock(\/|$))[A-Za-z0-9._/{}-]*$/;

export class UpdateGitBranchSettingsDto {
  @ApiProperty({
    example: 'feature/',
    description: "Optional; '{username}' is the developer's Git login",
  })
  @IsString()
  @MaxLength(30)
  @Matches(BRANCH_PREFIX_PATTERN, { message: 'invalid_prefix' })
  prefix!: string;

  @ApiProperty({ enum: ['upper', 'lower'] })
  @IsIn(['upper', 'lower'])
  keyCase!: 'upper' | 'lower';
}

export class ConnectGithubInstallationDto {
  @ApiProperty({
    description: 'The signed `pick` token from the callback redirect',
  })
  @IsString()
  @MaxLength(20000)
  token!: string;

  @ApiProperty()
  @IsString()
  @Matches(/^\d{1,20}$/)
  installationId!: string;
}

export class ConnectGitlabGroupDto {
  @ApiProperty()
  @IsUUID()
  credentialId!: string;

  @ApiProperty()
  @IsString()
  @Matches(/^\d{1,20}$/)
  groupId!: string;
}

export class ConnectAzureDevopsOrganizationDto {
  @ApiProperty()
  @IsUUID()
  credentialId!: string;

  /** The organization's `accountId`. */
  @ApiProperty()
  @IsUUID()
  organizationId!: string;
}

/** Ticket 4: link a pull request / merge request to a task by its address. */
export class LinkPullRequestDto {
  @ApiProperty({ example: 'https://github.com/acme/api/pull/12' })
  @IsString()
  @MaxLength(2048)
  url!: string;
}

/** Ticket 11: register an organization's own GitHub Enterprise Server / self-managed GitLab. */
export class CreateGitServerDto {
  @ApiProperty({ enum: ['github', 'gitlab'] })
  @IsIn(['github', 'gitlab'])
  provider!: 'github' | 'gitlab';

  @ApiProperty({ example: 'https://gitlab.company.local' })
  @IsString()
  @MaxLength(500)
  baseUrl!: string;

  @ApiProperty({ example: 'Company GitLab' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;
}

/**
 * Ticket 11: change a server. Omitted fields stay; secrets are write-only (an empty string clears one).
 * A new `baseUrl` keeps every link (the server's key never changes).
 */
export class UpdateGitServerDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  baseUrl?: string;

  @ApiPropertyOptional({ description: 'GitHub App ID' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{0,20}$/, { message: 'invalid_app_id' })
  appId?: string;

  @ApiPropertyOptional({
    description: 'GitHub App client id / GitLab application id',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  clientId?: string;

  @ApiPropertyOptional({ description: 'Write-only' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  clientSecret?: string;

  @ApiPropertyOptional({
    description: 'GitHub App private key (.pem), write-only',
  })
  @IsOptional()
  @IsString()
  @MaxLength(10000)
  privateKey?: string;
}
