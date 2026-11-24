import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreatePublicTicketDto {
  @ApiProperty()
  @IsUUID()
  spaceId!: string;

  @ApiProperty({ maxLength: 255 })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  summary!: string;

  @ApiPropertyOptional({ maxLength: 10000 })
  @IsOptional()
  @IsString()
  @MaxLength(10000)
  description?: string;

  @ApiProperty({ enum: ['low', 'medium', 'high', 'critical'] })
  @IsIn(['low', 'medium', 'high', 'critical'])
  priority!: 'low' | 'medium' | 'high' | 'critical';

  @ApiProperty()
  @IsUUID()
  funnelId!: string;

  @ApiProperty()
  @IsUUID()
  pageId!: string;
}
