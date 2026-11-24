import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateSavedFilterDto {
  @ApiPropertyOptional({
    description: 'Legacy client org id; ignored in favor of auth context',
  })
  @IsOptional()
  @IsString()
  organizationId?: string;

  @ApiProperty({ description: 'Filter name', maxLength: 255 })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @ApiProperty({
    description: 'Query rule group { combinator, rules }',
    type: Object,
  })
  @IsObject()
  query!: Record<string, unknown>;

  @ApiProperty({
    enum: ['spaces', 'processes', 'tasks', 'lists', 'wiki', 'filter'],
  })
  @IsIn(['spaces', 'processes', 'tasks', 'lists', 'wiki', 'filter'])
  source_type!: 'spaces' | 'processes' | 'tasks' | 'lists' | 'wiki' | 'filter';

  @ApiPropertyOptional({ type: [String], description: 'Space UUIDs' })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  source_space_ids?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  source_entity_types?: string[];

  @ApiPropertyOptional({ description: 'Required when source_type=filter' })
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

  @ApiPropertyOptional({
    enum: ['private', 'space', 'organization'],
    default: 'private',
  })
  @IsOptional()
  @IsIn(['private', 'space', 'organization'])
  visibility?: 'private' | 'space' | 'organization';

  @ApiPropertyOptional({ enum: ['list', 'hierarchy'], default: 'list' })
  @IsOptional()
  @IsIn(['list', 'hierarchy'])
  view_type?: 'list' | 'hierarchy';
}
