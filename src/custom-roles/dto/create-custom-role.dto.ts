import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsHexColor,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateCustomRoleDto {
  @ApiProperty({ description: 'Role name', maxLength: 100 })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({ description: 'Role description', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @ApiPropertyOptional({ description: 'Hex color', example: '#6B7280' })
  @IsOptional()
  @IsHexColor()
  color?: string;

  @ApiPropertyOptional({ description: 'Icon name', maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  icon?: string | null;

  @ApiPropertyOptional({
    enum: ['owner', 'admin', 'member', 'viewer'],
    default: 'member',
  })
  @IsOptional()
  @IsIn(['owner', 'admin', 'member', 'viewer'])
  base_role?: string;

  @ApiPropertyOptional({
    description: 'Permissions JSONB object',
    type: Object,
  })
  @IsOptional()
  @IsObject()
  permissions?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Whether role is active', default: true })
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}
