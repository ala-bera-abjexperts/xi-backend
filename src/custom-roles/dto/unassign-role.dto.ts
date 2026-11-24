import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

export class UnassignRoleDto {
  @ApiProperty({ description: 'User ID to remove role from' })
  @IsUUID()
  user_id!: string;

  @ApiPropertyOptional({
    description: 'Role ID (if omitted, removes ALL roles from user)',
  })
  @IsOptional()
  @IsUUID()
  role_id?: string;
}
