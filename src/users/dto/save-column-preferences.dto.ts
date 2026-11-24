import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsNotEmpty,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { ColumnConfigItemDto } from './column-config-item.dto';

export class SaveColumnPreferencesDto {
  @ApiProperty({
    description:
      'View identifier (e.g. tasks, processes, gdpr, list-items, backlog, plan_gantt)',
    maxLength: 100,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  view_id!: string;

  @ApiProperty({ type: [ColumnConfigItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ColumnConfigItemDto)
  column_config!: ColumnConfigItemDto[];
}
