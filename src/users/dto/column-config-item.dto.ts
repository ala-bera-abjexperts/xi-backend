import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsNotEmpty, IsString, Min } from 'class-validator';

export class ColumnConfigItemDto {
  @ApiProperty({ description: 'Column identifier' })
  @IsString()
  @IsNotEmpty()
  id!: string;

  @ApiProperty({ description: 'Whether the column is visible' })
  @IsBoolean()
  visible!: boolean;

  @ApiProperty({ description: 'Display order (0-based)', minimum: 0 })
  @IsInt()
  @Min(0)
  order!: number;
}
