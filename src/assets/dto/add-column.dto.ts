import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ValidateNested } from 'class-validator';
import { ColumnConfigItemDto } from './column-config-item.dto';

export class AddColumnDto {
  @ApiProperty({ type: ColumnConfigItemDto })
  @ValidateNested()
  @Type(() => ColumnConfigItemDto)
  column!: ColumnConfigItemDto;
}
