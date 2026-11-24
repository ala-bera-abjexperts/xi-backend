import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';

export class PatchUserGroupDto {
  @ApiProperty({ enum: ['restore', 'permanent_delete', 'duplicate'] })
  @IsIn(['restore', 'permanent_delete', 'duplicate'])
  action!: 'restore' | 'permanent_delete' | 'duplicate';

  @ApiPropertyOptional({ description: 'New name (required for duplicate)' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  newName?: string;

  @ApiPropertyOptional({
    description:
      'Organization ID (accepted from frontend, JWT org is always used)',
  })
  @IsOptional()
  @IsUUID('loose')
  organizationId?: string;

  @ApiPropertyOptional({
    description: 'When duplicating, copy existing group members too.',
  })
  @IsOptional()
  @IsBoolean()
  copyMembers?: boolean;
}
