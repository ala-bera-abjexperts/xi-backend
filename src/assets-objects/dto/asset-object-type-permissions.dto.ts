import {
  IsArray,
  IsBoolean,
  IsOptional,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AssetObjectTypeGroupPermissionEntryDto {
  @IsUUID()
  @ApiProperty({ description: 'User group UUID' })
  group_id: string;

  @IsBoolean()
  @IsOptional()
  @ApiPropertyOptional({
    description: 'Allow viewing objects of this type',
    default: true,
  })
  can_view?: boolean;

  @IsBoolean()
  @IsOptional()
  @ApiPropertyOptional({
    description: 'Allow creating objects of this type',
    default: false,
  })
  can_create?: boolean;

  @IsBoolean()
  @IsOptional()
  @ApiPropertyOptional({
    description: 'Allow editing objects of this type',
    default: false,
  })
  can_edit?: boolean;

  @IsBoolean()
  @IsOptional()
  @ApiPropertyOptional({
    description: 'Allow deleting objects of this type',
    default: false,
  })
  can_delete?: boolean;
}

export class AssetObjectTypeUserPermissionEntryDto {
  @IsUUID()
  @ApiProperty({ description: 'User UUID' })
  user_id: string;

  @IsBoolean()
  @IsOptional()
  @ApiPropertyOptional({
    description: 'Allow viewing objects of this type',
    default: true,
  })
  can_view?: boolean;

  @IsBoolean()
  @IsOptional()
  @ApiPropertyOptional({
    description: 'Allow creating objects of this type',
    default: false,
  })
  can_create?: boolean;

  @IsBoolean()
  @IsOptional()
  @ApiPropertyOptional({
    description: 'Allow editing objects of this type',
    default: false,
  })
  can_edit?: boolean;

  @IsBoolean()
  @IsOptional()
  @ApiPropertyOptional({
    description: 'Allow deleting objects of this type',
    default: false,
  })
  can_delete?: boolean;
}

export class SetAssetObjectTypePermissionsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AssetObjectTypeGroupPermissionEntryDto)
  @ApiProperty({
    type: [AssetObjectTypeGroupPermissionEntryDto],
    description:
      'List of group permission entries. Empty array removes all restrictions.',
  })
  group_permissions: AssetObjectTypeGroupPermissionEntryDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AssetObjectTypeUserPermissionEntryDto)
  @IsOptional()
  @ApiPropertyOptional({
    type: [AssetObjectTypeUserPermissionEntryDto],
    description: 'List of individual user permission entries.',
  })
  user_permissions?: AssetObjectTypeUserPermissionEntryDto[];
}
