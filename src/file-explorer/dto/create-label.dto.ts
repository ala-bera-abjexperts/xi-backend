import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsHexColor,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateLabelDto {
  @ApiProperty()
  @IsUUID()
  space_id!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({ default: '#6366f1' })
  @IsOptional()
  @IsHexColor()
  color?: string;
}
