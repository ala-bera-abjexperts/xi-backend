import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsInt, IsUUID, Min, ValidateNested } from 'class-validator';

class QuickFilterOrderItemDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  id!: string;

  @ApiProperty({ example: 0, minimum: 0 })
  @IsInt()
  @Min(0)
  sort_order!: number;
}

export class ReorderQuickFiltersDto {
  @ApiProperty({ type: [QuickFilterOrderItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => QuickFilterOrderItemDto)
  quick_filters!: QuickFilterOrderItemDto[];
}
