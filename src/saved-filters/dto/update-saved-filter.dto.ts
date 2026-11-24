import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class UpdateSavedFilterDto {
  @ApiPropertyOptional({
    description: 'Legacy client org id; ignored in favor of auth context',
  })
  @IsOptional()
  @IsString()
  organizationId?: string;

  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  query?: Record<string, unknown>;

  @ApiPropertyOptional({
    enum: ['spaces', 'processes', 'tasks', 'lists', 'wiki', 'filter'],
  })
  @IsOptional()
  @IsIn(['spaces', 'processes', 'tasks', 'lists', 'wiki', 'filter'])
  source_type?: 'spaces' | 'processes' | 'tasks' | 'lists' | 'wiki' | 'filter';

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  source_space_ids?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  source_entity_types?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('4')
  source_filter_id?: string | null;

  @ApiPropertyOptional({ type: [Object] })
  @IsOptional()
  @IsArray()
  columns?: Record<string, unknown>[];

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  sort_config?: Record<string, unknown> | null;

  @ApiPropertyOptional({ enum: ['private', 'space', 'organization'] })
  @IsOptional()
  @IsIn(['private', 'space', 'organization'])
  visibility?: 'private' | 'space' | 'organization';

  @ApiPropertyOptional({ enum: ['list', 'hierarchy'] })
  @IsOptional()
  @IsIn(['list', 'hierarchy'])
  view_type?: 'list' | 'hierarchy';
}
