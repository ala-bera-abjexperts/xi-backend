/**
 * @fileoverview DTO for toggling archive state of a GDPR record.
 * @module src/gdpr/dto/toggle-archive.dto
 */

import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class ToggleArchiveDto {
  @IsOptional()
  @IsString()
  organizationId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;

  @ApiProperty()
  @IsBoolean()
  is_archived!: boolean;
}
