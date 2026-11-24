import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class CreateRelationDto {
  @ApiProperty()
  @IsUUID('4')
  target_item_id!: string;

  @ApiProperty()
  @IsUUID('4')
  relation_type_id!: string;
}
