import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';

export class FilterPermissionItemDto {
  @ApiProperty({ enum: ['user', 'group', 'role', 'space'] })
  @IsIn(['user', 'group', 'role', 'space'])
  target_type!: 'user' | 'group' | 'role' | 'space';

  @ApiProperty()
  @IsUUID()
  target_id!: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  can_view?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  can_edit?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  can_delete?: boolean;
}

export class SetFilterPermissionsDto {
  @ApiPropertyOptional({
    description: 'Legacy client org id; ignored in favor of auth context',
  })
  @IsOptional()
  @IsString()
  organizationId?: string;

  @ApiProperty({ type: [FilterPermissionItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FilterPermissionItemDto)
  permissions!: FilterPermissionItemDto[];
}
