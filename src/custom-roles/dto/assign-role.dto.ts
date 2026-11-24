import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

export class AssignRoleDto {
  @ApiProperty({ description: 'User ID to assign the role to' })
  @IsUUID('loose')
  user_id!: string;

  @ApiProperty({ description: 'Role ID to assign' })
  @IsUUID('loose')
  role_id!: string;

  @ApiPropertyOptional({ description: 'Organization ID (defaults to JWT org)' })
  @IsOptional()
  @IsUUID('loose')
  organizationId?: string;
}
