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

export class CustomFieldOrderDto {
  @ApiProperty()
  @IsUUID('4')
  assignment_id!: string;

  @ApiProperty()
  @IsInt()
  @Min(0)
  sort_order!: number;
}

export class ReorderCustomFieldsDto {
  @ApiProperty({ type: [CustomFieldOrderDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CustomFieldOrderDto)
  field_orders!: CustomFieldOrderDto[];
}
