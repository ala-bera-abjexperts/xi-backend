/**
 * @fileoverview DTO for setting wiki page permissions.
 * @module src/wiki/dto/set-page-permissions.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

class WikiPermissionEntryDto {
  @IsIn(['user', 'role', 'group'])
  entity_type!: string;

  @IsString()
  @IsNotEmpty()
  entity_id!: string;

  @IsBoolean()
  can_view!: boolean;

  @IsBoolean()
  can_edit!: boolean;

  @IsBoolean()
  can_delete!: boolean;
}

export class SetPagePermissionsDto {
  @ApiProperty({
    type: [WikiPermissionEntryDto],
    description: 'Permission entries to set on this page',
  })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => WikiPermissionEntryDto)
  permissions!: WikiPermissionEntryDto[];

  @ApiPropertyOptional({
    default: true,
    description: 'Propagate permissions to children without custom permissions',
  })
  @IsOptional()
  @IsBoolean()
  apply_to_children?: boolean;
}
