import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';

export class ReorderObjectSchemaItemDto {
  @ApiProperty({ description: 'Schema UUID' })
  @IsUUID('4')
  id!: string;

  @ApiProperty({ description: 'Zero-based position in the list', minimum: 0 })
  @IsInt()
  @Min(0)
  sort_order!: number;
}

export class ReorderObjectSchemasDto {
  @ApiProperty({
    type: [ReorderObjectSchemaItemDto],
    description:
      'Every schema the client is displaying, in its new order. Sending the whole list avoids translating an index from a filtered view.',
  })
  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => ReorderObjectSchemaItemDto)
  items!: ReorderObjectSchemaItemDto[];
}
