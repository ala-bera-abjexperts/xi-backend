import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';

export class PatchCustomRoleDto {
  @ApiProperty({
    enum: [
      'toggle_active',
      'restore',
      'permanent_delete',
      'duplicate',
      'check_usage',
    ],
  })
  @IsIn([
    'toggle_active',
    'restore',
    'permanent_delete',
    'duplicate',
    'check_usage',
  ])
  action!:
    | 'toggle_active'
    | 'restore'
    | 'permanent_delete'
    | 'duplicate'
    | 'check_usage';

  @ApiPropertyOptional({ description: 'Required for toggle_active' })
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  @ApiPropertyOptional({ description: 'Required for duplicate' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  newName?: string;

  @ApiPropertyOptional({ description: 'Organization ID (for duplicate)' })
  @IsOptional()
  @IsUUID()
  organizationId?: string;
}
