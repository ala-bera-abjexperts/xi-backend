import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsUUID,
  IsInt,
  Min,
  ValidateNested,
  ArrayMinSize,
} from 'class-validator';

class SwimlaneOrderItemDto {
  @ApiProperty()
  @IsUUID('4')
  id!: string;

  @ApiProperty()
  @IsInt()
  @Min(0)
  sort_order!: number;
}

export class ReorderSwimlanesDto {
  @ApiProperty({ type: [SwimlaneOrderItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SwimlaneOrderItemDto)
  swimlanes!: SwimlaneOrderItemDto[];
}
