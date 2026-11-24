import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

// Credential typed into the dialog. Omit it when editing to reuse the stored token.
export class ListGithubReposDto {
  @ApiPropertyOptional({
    description: 'GitHub PAT; falls back to the stored token.',
  })
  @IsOptional()
  @IsString()
  credential?: string;
}
