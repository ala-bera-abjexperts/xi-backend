import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import { ExecuteFilterDto } from '../../saved-filters/dto/execute-filter.dto';
import {
  FILTER_EXPORT_FORMATS,
  FILTER_EXPORT_LOCALES,
  type FilterExportFormat,
  type FilterExportLocale,
} from '../filter-export.types';

export class ExportFilterColumnDto {
  @ApiProperty()
  @IsString()
  @MaxLength(200)
  id!: string;

  @ApiProperty({ description: 'Heading as shown in the filter view' })
  @IsString()
  @MaxLength(300)
  label!: string;
}

/** The filter state at click time: the query may hold edits that are not saved yet. */
export class ExportFilterDto extends ExecuteFilterDto {
  @ApiProperty({ enum: FILTER_EXPORT_FORMATS })
  @IsIn(FILTER_EXPORT_FORMATS)
  format!: FilterExportFormat;

  @ApiProperty({ type: [ExportFilterColumnDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ExportFilterColumnDto)
  columns!: ExportFilterColumnDto[];

  @ApiProperty({ enum: FILTER_EXPORT_LOCALES })
  @IsIn(FILTER_EXPORT_LOCALES)
  locale!: FilterExportLocale;

  @ApiPropertyOptional({ example: 'Europe/Vienna' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  time_zone?: string;
}
