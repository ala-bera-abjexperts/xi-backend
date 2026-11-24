import { ApiProperty } from '@nestjs/swagger';
import { IsArray } from 'class-validator';

export class SaveContentDto {
  @ApiProperty({
    description: 'EditorElement tree — array with a single __body root element',
  })
  @IsArray()
  content!: unknown[];
}
