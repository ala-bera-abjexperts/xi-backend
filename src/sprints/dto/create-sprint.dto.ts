import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  MinLength,
  MaxLength,
  IsOptional,
  IsDateString,
  IsUUID,
} from 'class-validator';

export class CreateSprintDto {
  @ApiPropertyOptional({
    description: 'Legacy organization UUID from Next clients (ignored)',
  })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiProperty({ example: 'Sprint 1' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({ example: 'Ship user authentication' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  goal?: string;

  @ApiPropertyOptional({ example: '2026-04-21' })
  @IsOptional()
  @IsDateString()
  start_date?: string;

  @ApiPropertyOptional({ example: '2026-05-04' })
  @IsOptional()
  @IsDateString()
  end_date?: string;
}
