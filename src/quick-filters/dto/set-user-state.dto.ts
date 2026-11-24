import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class SetUserStateDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  is_active!: boolean;
}
