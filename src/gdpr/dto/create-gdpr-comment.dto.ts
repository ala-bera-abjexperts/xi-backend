/**
 * @fileoverview DTO for creating a GDPR record comment.
 * @module src/gdpr/dto/create-gdpr-comment.dto
 */

import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateGdprCommentDto {
  @IsOptional()
  @IsString()
  organizationId?: string;

  @IsOptional()
  @IsString()
  spreadsheetId?: string;

  @IsOptional()
  @IsString()
  spreadsheet_id?: string;

  @IsOptional()
  @IsString()
  record_id?: string;

  @ApiProperty({ maxLength: 5_000 })
  @IsString()
  @MinLength(1)
  @MaxLength(5_000)
  content!: string;
}
