import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

export class VerifySharePasswordDto {
  @ApiProperty()
  @IsString()
  @MaxLength(100)
  password!: string;
}
