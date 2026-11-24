import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class UpdateFormPublicLinkDto {
  /** Whether the form should be served at its public URL. */
  @IsBoolean()
  is_public!: boolean;
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(63)
  @Matches(/^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])?$/, {
    message:
      'Slug may contain lowercase letters, numbers and hyphens, and must start and end with a letter or number',
  })
  public_slug?: string;
}
