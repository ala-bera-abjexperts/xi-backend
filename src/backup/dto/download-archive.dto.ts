/**
 * @fileoverview Body for downloading one archive.
 * @module src/backup/dto/download-archive.dto
 *
 * This class has to exist even though its only field is optional: the global ValidationPipe runs
 * with `whitelist` and `forbidNonWhitelisted`, so a POST carrying a key no DTO declares is a 400 —
 * including the `{ passphrase }` the download dialog sends.
 *
 * The passphrase travels in the body rather than the URL on purpose. A query parameter would be
 * written to browser history, proxy logs, the referrer header and any access log in between.
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class DownloadArchiveDto {
  @ApiPropertyOptional({
    description:
      "The scheme's archive passphrase. Required for an encrypted archive, ignored for a plain one.",
  })
  @IsOptional()
  @IsString()
  // Bounded so an oversized body cannot force an expensive scrypt derivation.
  @MaxLength(1024)
  passphrase?: string;
}
