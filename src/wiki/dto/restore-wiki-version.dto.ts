/**
 * @fileoverview DTO for restoring a wiki page to a prior version.
 * @module src/wiki/dto/restore-wiki-version.dto
 */

import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Min } from 'class-validator';

export class RestoreWikiVersionDto {
  @ApiProperty({ description: 'Version number to restore' })
  @IsInt()
  @Min(1)
  version!: number;
}
