import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';

export class ItemOrderDto {
  @ApiProperty()
  @IsUUID('4')
  item_id!: string;

  @ApiProperty()
  @IsInt()
  @Min(0)
  row_order!: number;
}

export class ReorderItemsDto {
  @ApiProperty()
  @IsUUID('4')
  schemaId!: string;

  @ApiProperty({ type: [ItemOrderDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ItemOrderDto)
  orders!: ItemOrderDto[];
}
