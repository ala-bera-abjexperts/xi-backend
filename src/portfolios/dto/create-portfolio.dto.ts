import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreatePortfolioDto {
  @ApiProperty({ maxLength: 255 })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @ApiPropertyOptional({ enum: ['draft', 'active', 'on_hold', 'completed'] })
  @IsOptional()
  @IsIn(['draft', 'active', 'on_hold', 'completed'])
  status?: 'draft' | 'active' | 'on_hold' | 'completed';

  @ApiPropertyOptional({ maxLength: 32 })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  color?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  owner_id?: string | null;
}
