/**
 * @fileoverview Query DTO for the discovery preview route
 * (`GET /migration/connections/:connectionId/discovery/preview?projectKey=…`).
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, Matches } from 'class-validator';

export class DiscoveryQueryDto {
  @ApiProperty({
    description: 'Jira project key to preview, e.g. "KAN"',
    example: 'KAN',
  })
  @IsString()
  @Matches(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, { message: 'Invalid project key' })
  projectKey!: string;

  @ApiPropertyOptional({
    description:
      'Model a provisioning-enabled run: report which users WOULD get an account. Still read-only — nothing is created and no mail is sent.',
    example: true,
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  provisionUsers?: boolean;

  @ApiPropertyOptional({
    description:
      'Model an invite-enabled run: report who WOULD be invited and with which org role. Still read-only.',
    example: true,
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  inviteUsers?: boolean;
}

export class SpacePreviewQueryDto {
  @ApiProperty({
    description: 'Confluence space key to preview, e.g. "M0"',
    example: 'M0',
  })
  @IsString()
  @Matches(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, { message: 'Invalid space key' })
  spaceKey!: string;
}
