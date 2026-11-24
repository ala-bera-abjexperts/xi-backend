import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

export class SpacePermissionItemDto {
  @ApiProperty({ description: 'Permission key to update' })
  @IsString()
  @IsNotEmpty()
  permKey!: string;

  @ApiProperty({ description: 'Target type: role | base_role | group' })
  @IsString()
  @IsNotEmpty()
  targetType!: string;

  @ApiPropertyOptional({ description: 'Target entity ID (for role/group)' })
  @IsOptional()
  @IsString()
  targetId?: string | null;

  @ApiPropertyOptional({
    description: 'Base role name (for base_role target type)',
  })
  @IsOptional()
  @IsString()
  baseRole?: string | null;

  @ApiProperty({ description: 'Permission value to set' })
  @IsBoolean()
  value!: boolean;
}

export class BulkSpacePermissionDto {
  @ApiProperty({ type: [SpacePermissionItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SpacePermissionItemDto)
  permissions!: SpacePermissionItemDto[];
}
