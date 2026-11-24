import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Keys to check against Google.
 *
 * POST rather than GET specifically so the SECRET never lands in a URL, where it would reach access
 * logs, proxies and browser history. Nothing here is stored — the pair is checked and discarded.
 */
export class CheckRecaptchaKeysDto {
  @ApiPropertyOptional({ description: 'reCAPTCHA site key (public half).' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  site_key?: string;

  @ApiPropertyOptional({
    description: 'reCAPTCHA secret key. Never logged or echoed back.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  secret_key?: string;

  @ApiPropertyOptional({
    description:
      'Origin the widget will run on, e.g. https://forms.example.com. Google validates the key against it, so without one every size check returns a false negative.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  origin?: string;
}
