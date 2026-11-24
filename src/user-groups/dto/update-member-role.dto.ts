import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

export class UpdateMemberRoleDto {
  @ApiProperty({ description: 'User ID whose role to update' })
  @IsUUID('loose')
  user_id!: string;

  @ApiPropertyOptional({ description: 'New role ID (null to remove role)' })
  @IsOptional()
  @IsUUID('loose')
  role_id?: string | null;
}
