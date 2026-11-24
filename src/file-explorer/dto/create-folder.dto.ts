import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateFolderDto {
  @ApiProperty()
  @IsUUID()
  space_id!: string;

  @ApiPropertyOptional({ description: 'Parent folder ID. Omit for root.' })
  @IsOptional()
  @IsUUID()
  parent_id?: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;
}
