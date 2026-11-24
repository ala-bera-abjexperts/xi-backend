import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { TASK_SIDEBAR_PROPERTY_IDS } from '../task-sidebar-preferences.constants';

export class TaskSidebarPropertyDto {
  @ApiProperty({ enum: TASK_SIDEBAR_PROPERTY_IDS })
  @IsString()
  @IsNotEmpty()
  @IsIn(TASK_SIDEBAR_PROPERTY_IDS)
  id!: string;

  @ApiProperty()
  @IsBoolean()
  visible!: boolean;

  @ApiProperty({ minimum: 0 })
  @IsInt()
  @Min(0)
  order!: number;
}

export class SaveTaskSidebarPreferencesDto {
  @ApiProperty({ type: [TaskSidebarPropertyDto] })
  @IsArray()
  @ArrayMaxSize(32)
  @ValidateNested({ each: true })
  @Type(() => TaskSidebarPropertyDto)
  properties!: TaskSidebarPropertyDto[];
}
