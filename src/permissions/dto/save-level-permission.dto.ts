import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class SaveLevelPermissionDto {
  @ApiPropertyOptional({
    description:
      'Hierarchy level ID. Legacy clients may pass null for the global/default matrix.',
  })
  @IsOptional()
  @IsString()
  hierarchyLevelId?: string | null;

  @ApiProperty({ description: 'Entity type: process | task' })
  @IsString()
  @IsNotEmpty()
  entityType!: string;

  @ApiProperty({ description: 'Target type: user | role | group | base_role' })
  @IsString()
  @IsNotEmpty()
  targetType!: string;

  @ApiPropertyOptional({ description: 'Target entity ID' })
  @IsOptional()
  @IsString()
  targetId?: string | null;

  @ApiPropertyOptional({
    description: 'Base role name (for base_role target type)',
  })
  @IsOptional()
  @IsString()
  baseRole?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  can_view?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  can_create?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  can_edit?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  can_delete?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  can_view_history?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  can_view_attachments?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  can_add_attachments?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  can_delete_attachments?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  can_view_comments?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  can_add_comments?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  can_delete_comments?: boolean;
}
