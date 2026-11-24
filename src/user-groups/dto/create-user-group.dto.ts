import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateUserGroupDto {
  @ApiProperty({ description: 'Group name', maxLength: 100 })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({ description: 'Group description', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @ApiPropertyOptional({
    description: 'Hex color code (6-digit)',
    example: '#6B7280',
  })
  @IsOptional()
  @Matches(/^#[0-9A-Fa-f]{6}$/, {
    message: 'color must be a valid 6-digit hex color (e.g. #6B7280)',
  })
  color?: string;

  @ApiPropertyOptional({ description: 'Default role ID for new members' })
  @IsOptional()
  @IsUUID('loose')
  default_role_id?: string | null;

  @ApiPropertyOptional({
    description: 'Organization ID (sent by frontend, ignored — JWT is used)',
  })
  @IsOptional()
  @IsUUID('loose')
  organizationId?: string;
}
