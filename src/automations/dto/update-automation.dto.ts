import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  MinLength,
  MaxLength,
  IsOptional,
  IsNumber,
  Min,
  Max,
} from 'class-validator';

export class UpdateAutomationDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 200 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  icon?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 1000 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(1000)
  webhook_rate_limit_per_sec?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 1000000 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(1000000)
  webhook_rate_limit_per_hour?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  max_concurrent_runs?: number | null;

  @ApiPropertyOptional({ enum: ['hmac-sha256', 'none'] })
  @IsOptional()
  @IsString()
  webhook_signature_scheme?: string;
}
