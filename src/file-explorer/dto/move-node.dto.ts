import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

export class MoveNodeDto {
  @ApiProperty({ description: 'Destination folder ID. Null for root.' })
  @IsOptional()
  @IsUUID()
  target_parent_id?: string;

  @ApiProperty()
  @IsUUID()
  space_id!: string;
}
