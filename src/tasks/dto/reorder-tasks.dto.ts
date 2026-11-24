import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsOptional,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ReorderTaskItemDto {
  @ApiProperty()
  @IsUUID()
  id!: string;

  @ApiProperty({ minimum: 0 })
  @IsInt()
  @Min(0)
  sort_order!: number;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsUUID()
  parent_task_id?: string | null;
}

export class ReorderTasksDto {
  @ApiProperty({ type: [ReorderTaskItemDto] })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => ReorderTaskItemDto)
  updates!: ReorderTaskItemDto[];
}
