import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class FilterSortDto {
  @ApiProperty({ description: 'Field or custom field key to sort by' })
  @IsString()
  column!: string;

  @ApiProperty({ enum: ['asc', 'desc'] })
  @IsIn(['asc', 'desc'])
  direction!: 'asc' | 'desc';
}

export class ExecuteFilterDto {
  @ApiPropertyOptional({
    description: 'Legacy client org id; ignored in favor of auth context',
  })
  @IsOptional()
  @IsString()
  organizationId?: string;

  @ApiProperty({ description: 'Query rule group', type: Object })
  @IsObject()
  query!: Record<string, unknown>;

  @ApiProperty({
    enum: ['spaces', 'processes', 'tasks', 'lists', 'wiki', 'filter'],
  })
  @IsIn(['spaces', 'processes', 'tasks', 'lists', 'wiki', 'filter'])
  source_type!: 'spaces' | 'processes' | 'tasks' | 'lists' | 'wiki' | 'filter';

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
  source_filter_id?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number;

  @ApiPropertyOptional({ type: FilterSortDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => FilterSortDto)
  sort?: FilterSortDto;
}
