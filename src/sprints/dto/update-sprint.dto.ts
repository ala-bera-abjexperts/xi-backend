import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  MinLength,
  MaxLength,
  IsOptional,
  IsNumber,
  Min,
  IsUUID,
} from 'class-validator';

export class UpdateSprintDto {
  @ApiPropertyOptional({ description: 'Legacy sprint ID echo from clients' })
  @IsOptional()
  @IsUUID()
  id?: string;

  @ApiPropertyOptional({
    description: 'Legacy organization UUID from Next clients (ignored)',
  })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiPropertyOptional({ example: 'Sprint 1' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ example: 'Ship user authentication' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  goal?: string;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  sort_order?: number;
}
