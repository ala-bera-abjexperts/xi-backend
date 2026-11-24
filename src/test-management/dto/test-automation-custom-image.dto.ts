import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, Length, Matches } from 'class-validator';

// Short lowercase names, the same rule as the image labels.
const LABEL_VALUE = /^[a-z0-9][a-z0-9.+_-]{0,49}$/;
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CheckTestAutomationCustomImageDto {
  @ApiProperty({
    description:
      'Image address pinned by digest, for example ghcr.io/team/tests@sha256:…',
  })
  @Transform(trim)
  @IsString()
  @Length(1, 600)
  image_ref!: string;

  @ApiPropertyOptional({
    description: 'Language of an image without labels, for example javascript',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Matches(LABEL_VALUE)
  language?: string;

  @ApiPropertyOptional({
    description:
      'Test framework of an image without labels, for example cypress',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Matches(LABEL_VALUE)
  test_framework?: string;
}

export class CustomImageHubSearchQueryDto {
  @ApiProperty({
    description:
      'A name, owner/name, a hub.docker.com link or a copied docker pull command',
  })
  @Transform(trim)
  @IsString()
  @Length(2, 300)
  q!: string;
}

export class CustomImageHubTagsQueryDto {
  @ApiProperty({ description: 'A Docker Hub image, such as apache/cassandra' })
  @Transform(trim)
  @IsString()
  @Length(1, 255)
  repository!: string;

  @ApiPropertyOptional({
    description: 'Only versions whose name contains this',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(0, 128)
  name?: string;
}

export type CustomImageStatus =
  | 'checking'
  | 'approved'
  | 'needs_admin'
  | 'refused'
  | 'blocked';

export interface CustomImageFindingItem {
  code: string;
  detail: string;
}

/** A custom image and the result of its check; the settings of this space that use it are listed. */
export interface CustomImage {
  id: string;
  image_ref: string;
  run_ref: string | null;
  registry: string;
  repository: string;
  digest: string;
  platform: string;
  language: string | null;
  test_framework: string | null;
  size_bytes: number | null;
  status: CustomImageStatus;
  error_code: string | null;
  findings: CustomImageFindingItem[];
  scan: Record<string, unknown>;
  created_at: string;
  checked_at: string | null;
  approved_at: string | null;
  blocked_at: string | null;
  config_ids: string[];
  // How far the worker is, while the image is being checked.
  progress?: Record<string, unknown>;
}
