/**
 * @fileoverview Body for replacing a scheme's archive passphrase.
 * @module src/backup/dto/rotate-scheme-passphrase.dto
 */

import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class RotateSchemePassphraseDto {
  /** Write-only. Encrypted at rest and never returned. */
  @ApiProperty({ description: 'New archive passphrase. Write-only.' })
  @IsString()
  @MinLength(8)
  @MaxLength(1024)
  passphrase!: string;
}
