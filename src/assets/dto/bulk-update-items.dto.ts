import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  Allow,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';

export class BulkCellUpdateDto {
  @ApiProperty()
  @IsUUID('4')
  item_id!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  column_id!: string;

  @ApiProperty({ type: Object })
  @Allow()
  value!: unknown;

  @ApiProperty()
  @IsInt()
  @Min(1)
  version!: number;
}

export class BulkUpdateItemsDto {
  @ApiProperty({ type: [BulkCellUpdateDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => BulkCellUpdateDto)
  updates!: BulkCellUpdateDto[];
}

export class BulkItemIdsDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('4', { each: true })
  ids!: string[];
}
