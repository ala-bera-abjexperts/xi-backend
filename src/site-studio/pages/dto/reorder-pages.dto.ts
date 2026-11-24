import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsInt, IsUUID, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class PageOrderItem {
  @IsUUID()
  id!: string;

  @IsInt()
  @Min(0)
  sort_order!: number;
}

export class ReorderPagesDto {
  @ApiProperty({ type: [PageOrderItem] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PageOrderItem)
  pages!: PageOrderItem[];
}
