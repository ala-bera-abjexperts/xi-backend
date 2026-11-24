import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class ColumnOrderDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  columnId!: string;

  @ApiProperty()
  @IsInt()
  @Min(0)
  order!: number;
}

export class ReorderColumnsDto {
  @ApiProperty({ type: [ColumnOrderDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ColumnOrderDto)
  column_order!: ColumnOrderDto[];
}
