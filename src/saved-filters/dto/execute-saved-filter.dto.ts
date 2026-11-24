import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { FilterSortDto } from './execute-filter.dto';

export class ExecuteSavedFilterDto {
  @ApiPropertyOptional({
    description: 'Legacy client org id; ignored in favor of auth context',
  })
  @IsOptional()
  @IsString()
  organizationId?: string;

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

  @ApiPropertyOptional({
    type: FilterSortDto,
    description: 'Sort config: { column: string, direction: "asc"|"desc" }',
  })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => FilterSortDto)
  sort?: FilterSortDto;
}
