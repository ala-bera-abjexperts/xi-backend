import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class SaveMenuPermissionDto {
  @ApiProperty({ description: 'Menu key identifier' })
  @IsString()
  @IsNotEmpty()
  menuKey!: string;

  @ApiProperty({ description: 'Target type: user | role | group | base_role' })
  @IsString()
  @IsNotEmpty()
  targetType!: string;

  @ApiPropertyOptional({
    description: 'Target entity ID (for user/role/group)',
  })
  @IsOptional()
  @IsString()
  targetId?: string | null;

  @ApiPropertyOptional({
    description: 'Base role name (for base_role target type)',
  })
  @IsOptional()
  @IsString()
  baseRole?: string | null;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  canView?: boolean;
}
