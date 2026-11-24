import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import {
  PICKER_LOOKUP_MAX_IDS,
  PICKER_MAX_PAGE_SIZE,
} from './task-picker.service';

export class TaskPickerSearchQueryDto {
  @IsUUID()
  spaceId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PICKER_MAX_PAGE_SIZE)
  pageSize: number = 25;
}

export class TaskPickerLookupDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(PICKER_LOOKUP_MAX_IDS)
  @IsUUID('all', { each: true })
  ids!: string[];
}
