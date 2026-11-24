/**
 * @fileoverview DTO for setting (replacing) all labels on a wiki page.
 * @module src/wiki/dto/set-page-labels.dto
 */

import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsUUID } from 'class-validator';

export class SetPageLabelsDto {
  @ApiProperty({
    type: [String],
    description: 'Complete set of label UUIDs to assign (replaces existing)',
  })
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  label_ids!: string[];
}
