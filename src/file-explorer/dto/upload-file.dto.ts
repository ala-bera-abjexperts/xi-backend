import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class UploadFileDto {
  @ApiProperty()
  @IsUUID()
  space_id!: string;

  @ApiPropertyOptional({ description: 'Parent folder ID. Omit for root.' })
  @IsOptional()
  @IsUUID()
  parent_id?: string;

  @ApiPropertyOptional({ description: 'Version comment' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;
}
