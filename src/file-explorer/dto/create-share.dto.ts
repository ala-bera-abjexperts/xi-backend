import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class CreateShareDto {
  @ApiProperty({ enum: ['link', 'user'] })
  @IsIn(['link', 'user'])
  share_type!: 'link' | 'user';

  @ApiPropertyOptional({
    description: 'Target user ID. Required when share_type=user.',
  })
  @IsOptional()
  @IsUUID()
  shared_with_id?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  can_view?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  can_create?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  can_delete?: boolean;

  @ApiPropertyOptional({
    description:
      'Password to protect the link share (plaintext, will be hashed)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  password?: string;

  @ApiPropertyOptional({ description: 'Share expiry date (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  expires_at?: string;
}
